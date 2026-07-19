/**
 * TraceAggregator — collects individual span events and reconstructs
 * complete trace trees with embedded `children` arrays.
 *
 * ## Problem
 *
 * OTel's BatchSpanProcessor exports spans individually. A single trace
 * (e.g. GET /api/users that calls MongoDB, Redis, and an external API)
 * produces 4+ separate span events. These arrive at the backend as flat,
 * disconnected events — the backend must reconstruct the tree by grouping
 * on traceId and linking via parentSpanId.
 *
 * ## Solution
 *
 * This aggregator buffers spans by traceId. When the **root span** arrives
 * (the span with no parentSpanId), we know the trace is complete because
 * in Node.js's synchronous request lifecycle, child spans always end
 * before the parent. At that point, we build the tree and emit a single
 * `trace` event with the full hierarchy.
 *
 * ## Safety
 *
 * - **Memory bounded**: Maximum pending traces (default: 1000), LRU eviction
 * - **Timeout safety**: Orphaned traces (no root arrives) are flushed after
 *   a configurable timeout (default: 30s) as partial traces
 * - **Thread-safe**: Single-threaded Node.js, no locks needed
 * - **Graceful shutdown**: flushAll() emits whatever is buffered
 */
import { getLogger } from '../utils/logger.js';
import { processEvent } from '../core/event-pipeline.js';
// ─── TraceAggregator ────────────────────────────────────────────────────────
export class TraceAggregator {
    pending = new Map();
    maxPendingTraces;
    orphanTimeoutMs;
    sweepIntervalMs;
    sweepTimer = null;
    constructor(config = {}) {
        this.maxPendingTraces = config.maxPendingTraces ?? 1000;
        this.orphanTimeoutMs = config.orphanTimeoutMs ?? 30_000;
        this.sweepIntervalMs = config.sweepIntervalMs ?? 10_000;
    }
    /**
     * Start the background sweep timer for orphaned traces.
     * Must be called after SDK init. Timer is `.unref()`'d so it won't
     * prevent the process from exiting.
     */
    start() {
        if (this.sweepTimer)
            return;
        this.sweepTimer = setInterval(() => this.sweepOrphans(), this.sweepIntervalMs);
        this.sweepTimer.unref();
    }
    /**
     * Stop the background sweep timer.
     */
    stop() {
        if (this.sweepTimer) {
            clearInterval(this.sweepTimer);
            this.sweepTimer = null;
        }
    }
    /**
     * Add a span event to the aggregator.
     *
     * If this span is the root (no parentSpanId), it triggers immediate
     * trace assembly and emission. Otherwise, the span is buffered until
     * the root arrives or the orphan timeout fires.
     *
     * @param spanEvent - The flat span event from PipelineSpanExporter
     */
    addSpan(spanEvent) {
        const traceId = spanEvent.traceId;
        const spanId = spanEvent.spanId;
        const parentSpanId = spanEvent.parentSpanId;
        if (!traceId || !spanId)
            return;
        let trace = this.pending.get(traceId);
        if (!trace) {
            // Enforce memory bound — evict oldest if at capacity
            if (this.pending.size >= this.maxPendingTraces) {
                this.evictOldest();
            }
            trace = {
                spans: new Map(),
                rootSpan: null,
                createdAt: Date.now(),
            };
            this.pending.set(traceId, trace);
        }
        trace.spans.set(spanId, spanEvent);
        // Root span detection: no parentSpanId means this is the root.
        if (!parentSpanId) {
            trace.rootSpan = spanEvent;
        }
    }
    /**
     * Flush the trace if its root span has arrived.
     * This is called by the exporter at the end of a batch process to ensure
     * all spans from the same batch are buffered before the trace is assembled.
     */
    flushIfComplete(traceId) {
        const trace = this.pending.get(traceId);
        if (trace && trace.rootSpan) {
            this.flushTrace(traceId);
        }
    }
    /**
     * Flush all pending traces (for shutdown).
     * Emits whatever is buffered, marking incomplete traces as partial.
     */
    flushAll() {
        const traceIds = Array.from(this.pending.keys());
        for (const traceId of traceIds) {
            this.flushTrace(traceId);
        }
    }
    /**
     * Get the number of pending traces in the buffer.
     */
    get pendingCount() {
        return this.pending.size;
    }
    // ─── Private ──────────────────────────────────────────────────────────────
    /**
     * Build the span tree and emit a complete trace event.
     */
    flushTrace(traceId) {
        const trace = this.pending.get(traceId);
        if (!trace)
            return;
        // Remove from pending before processing to prevent re-entry
        this.pending.delete(traceId);
        const logger = getLogger();
        try {
            const spans = Array.from(trace.spans.values());
            if (spans.length === 0)
                return;
            // Find the root span — either the one we detected or find by missing parentSpanId
            let rootSpanEvent = trace.rootSpan;
            if (!rootSpanEvent) {
                rootSpanEvent = spans.find(s => !s.parentSpanId) ?? null;
            }
            const isPartial = !rootSpanEvent;
            // If no root, pick the span with earliest startTime as synthetic root
            if (!rootSpanEvent) {
                rootSpanEvent = spans.reduce((earliest, s) => {
                    const eStart = earliest.startTime;
                    const sStart = s.startTime;
                    return sStart < eStart ? s : earliest;
                });
            }
            // Build the tree. Index children by parentSpanId once (O(n)) instead
            // of filtering the full span list at every recursion level (O(n²)) —
            // traces with thousands of spans would otherwise stall the event loop.
            const childrenByParent = new Map();
            for (const span of spans) {
                const parentId = span.parentSpanId;
                if (!parentId)
                    continue;
                const list = childrenByParent.get(parentId);
                if (list) {
                    list.push(span);
                }
                else {
                    childrenByParent.set(parentId, [span]);
                }
            }
            for (const list of childrenByParent.values()) {
                list.sort((a, b) => a.startTime - b.startTime);
            }
            const rootAggregated = this.buildTree(rootSpanEvent, childrenByParent);
            // Calculate total duration from root
            const totalDuration = rootSpanEvent.duration ?? 0;
            const traceDocument = {
                type: 'trace',
                eventId: `trace_${traceId}`,
                traceId,
                rootSpan: rootAggregated,
                spanCount: spans.length,
                totalDuration,
                isPartial,
                metadata: rootSpanEvent.metadata,
                requestId: rootSpanEvent.requestId,
                sessionId: rootSpanEvent.sessionId,
                userId: rootSpanEvent.userId,
                tenantId: rootSpanEvent.tenantId,
                __pulseInternal: true,
            };
            // Emit the aggregated trace event
            processEvent(traceDocument);
            logger.debug('Trace aggregated and emitted', {
                traceId,
                spanCount: spans.length,
                isPartial,
                totalDuration,
            });
        }
        catch (err) {
            logger.error('Failed to aggregate trace', { traceId, error: err });
        }
    }
    /**
     * Recursively build the span tree using the pre-built parentSpanId →
     * children index. Children lists are already sorted by startTime.
     */
    buildTree(rootEvent, childrenByParent) {
        const rootSpanId = rootEvent.spanId;
        // Find direct children of this span — O(1) lookup
        const children = (childrenByParent.get(rootSpanId) ?? [])
            .map(child => this.buildTree(child, childrenByParent));
        return {
            spanId: rootSpanId,
            parentSpanId: rootEvent.parentSpanId,
            name: rootEvent.name,
            kind: rootEvent.kind,
            startTime: rootEvent.startTime,
            endTime: rootEvent.endTime,
            duration: rootEvent.duration,
            exclusiveDuration: rootEvent.exclusiveDuration,
            status: rootEvent.status,
            statusMessage: rootEvent.statusMessage,
            attributes: rootEvent.attributes,
            events: rootEvent.events,
            links: rootEvent.links,
            children,
        };
    }
    /**
     * Sweep for orphaned traces that have exceeded the timeout.
     */
    sweepOrphans() {
        const now = Date.now();
        const toFlush = [];
        for (const [traceId, trace] of this.pending) {
            if (now - trace.createdAt > this.orphanTimeoutMs) {
                toFlush.push(traceId);
            }
        }
        if (toFlush.length > 0) {
            const logger = getLogger();
            logger.debug(`Sweeping ${toFlush.length} orphaned traces`, {
                orphanTimeoutMs: this.orphanTimeoutMs,
            });
            for (const traceId of toFlush) {
                this.flushTrace(traceId);
            }
        }
    }
    /**
     * Evict the oldest pending trace to make room for a new one.
     */
    evictOldest() {
        // Map iteration order is insertion order — first key is oldest
        const oldestTraceId = this.pending.keys().next().value;
        if (oldestTraceId) {
            getLogger().debug('Evicting oldest pending trace due to buffer overflow', {
                traceId: oldestTraceId,
            });
            this.flushTrace(oldestTraceId);
        }
    }
}
// ─── Singleton ──────────────────────────────────────────────────────────────
let instance = null;
/**
 * Get or create the singleton TraceAggregator instance.
 */
export function getTraceAggregator(config) {
    if (!instance) {
        instance = new TraceAggregator(config);
    }
    return instance;
}
/**
 * Reset the singleton (for shutdown/reinit).
 */
export function resetTraceAggregator() {
    if (instance) {
        instance.stop();
        instance.flushAll();
        instance = null;
    }
}
//# sourceMappingURL=trace-aggregator.js.map