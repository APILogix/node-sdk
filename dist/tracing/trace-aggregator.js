/**
 * TraceAggregator — collects individual span events and reconstructs
 * complete trace trees with embedded `children` arrays.
 *
 * ## Problem
 *
 * OTel's BatchSpanProcessor exports spans individually in batches. A single trace
 * (e.g. GET /api/users that calls MongoDB, Redis, and an external API)
 * produces multiple separate span events.
 *
 * Previously, the aggregator assumed:
 *   root span arrives = trace is immediately complete
 *
 * In asynchronous Node.js execution, child spans often arrive in later batches or
 * after the root span arrives. Flushing immediately caused late child spans to
 * form orphaned partial traces. Furthermore, if a trace was not head-sampled,
 * discarding child spans individually destroyed tail-sampling (error and slow-trace capture).
 *
 * ## Solution: Bounded Finalization Coordinator
 *
 * 1. This aggregator buffers spans by traceId.
 * 2. When the root span arrives, we start a bounded grace debounce timer
 *    (default: 100ms debounce, capped at 250ms hard deadline from root arrival).
 * 3. Any in-flight or next-batch child spans joining within this window are merged
 *    into the trace tree.
 * 4. At finalization, the SDK makes the authoritative trace-level sampling decision:
 *    - KEEP if: root was head-sampled OR any span has an error/exception OR total duration >= threshold
 *    - DISCARD if: unsampled normal trace
 * 5. `spanDurationTracker.cleanupTrace(traceId)` is invoked only after the trace is finalized.
 *
 * ## Safety & Bounded Resource Controls
 *
 * - **Memory bounded**: Maximum pending traces (default: 2000), LRU eviction
 * - **Timeout safety**: Orphaned traces (no root arrives) are flushed after
 *   a configurable timeout (default: 30s) as partial traces
 * - **Deterministic timers**: Debounce timers are unref'd so they do not block process exit
 * - **Graceful shutdown**: `flushAll()` immediately cancels pending timers and flushes all traces
 */
import { getLogger } from '../utils/logger.js';
import { processEvent } from '../core/event-pipeline.js';
import { spanDurationTracker } from './span-duration.js';
// ─── TraceAggregator ────────────────────────────────────────────────────────
export class TraceAggregator {
    pending = new Map();
    finalizedTraces = new Set();
    finalizedOrder = [];
    maxFinalizedHistory = 10_000;
    maxPendingTraces;
    orphanTimeoutMs;
    sweepIntervalMs;
    gracePeriodMs;
    maxFinalizationDelayMs;
    slowTraceThresholdMs;
    sweepTimer = null;
    constructor(config = {}) {
        this.maxPendingTraces = config.maxPendingTraces ?? 2000;
        this.orphanTimeoutMs = config.orphanTimeoutMs ?? 30_000;
        this.sweepIntervalMs = config.sweepIntervalMs ?? 10_000;
        this.gracePeriodMs = config.gracePeriodMs ?? 100;
        this.maxFinalizationDelayMs = config.maxFinalizationDelayMs ?? 250;
        this.slowTraceThresholdMs = config.slowTraceThresholdMs ?? 1000;
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
     * Record that a trace has been finalized.
     * Protects against resurrecting finalized traces into duplicate partial traces.
     */
    markFinalized(traceId) {
        this.finalizedTraces.add(traceId);
        this.finalizedOrder.push(traceId);
        if (this.finalizedOrder.length > this.maxFinalizedHistory) {
            const oldest = this.finalizedOrder.shift();
            if (oldest)
                this.finalizedTraces.delete(oldest);
        }
    }
    /**
     * Check whether a trace has already been finalized.
     */
    isFinalized(traceId) {
        return this.finalizedTraces.has(traceId);
    }
    /**
     * Invoked synchronously via SpanProcessor.onStart() when a span begins execution.
     * Increments activeSpanCount and tracks activity.
     * Protects against resurrecting finalized traces.
     */
    onSpanStart(traceId, spanId) {
        if (!traceId)
            return;
        // Protection: No trace resurrection!
        if (this.finalizedTraces.has(traceId)) {
            getLogger().debug('Span started for already-finalized trace — ignoring to prevent resurrection', {
                traceId,
                spanId,
            });
            return;
        }
        let trace = this.pending.get(traceId);
        if (!trace) {
            if (this.pending.size >= this.maxPendingTraces) {
                this.evictOldest();
            }
            trace = {
                traceId,
                state: 'OPEN',
                activeSpanCount: 0,
                rootEnded: false,
                lastActivityAt: Date.now(),
                finalizationDeadline: null,
                spans: new Map(),
                rootSpan: null,
                createdAt: Date.now(),
                quiescingTimer: null,
                deadlineTimer: null,
            };
            this.pending.set(traceId, trace);
        }
        trace.activeSpanCount++;
        trace.lastActivityAt = Date.now();
        // If new span starts while quiescing, cancel quiescing and return to active state!
        if (trace.state === 'QUIESCING') {
            if (trace.quiescingTimer) {
                clearTimeout(trace.quiescingTimer);
                trace.quiescingTimer = null;
            }
            trace.state = trace.rootEnded ? 'ROOT_ENDED' : 'OPEN';
        }
    }
    /**
     * Invoked synchronously via SpanProcessor.onEnd() when a span completes execution.
     * Decrements activeSpanCount and evaluates state transition:
     * ROOT_ENDED -> QUIESCING -> FINALIZED
     */
    onSpanEnd(traceId, spanId, isRoot) {
        if (!traceId || this.finalizedTraces.has(traceId))
            return;
        const trace = this.pending.get(traceId);
        if (!trace)
            return;
        if (trace.activeSpanCount > 0) {
            trace.activeSpanCount--;
        }
        trace.lastActivityAt = Date.now();
        if (isRoot) {
            trace.rootEnded = true;
            if (!trace.finalizationDeadline) {
                trace.finalizationDeadline = Date.now() + this.maxFinalizationDelayMs;
                trace.deadlineTimer = setTimeout(() => {
                    this.flushTrace(traceId);
                }, this.maxFinalizationDelayMs);
                trace.deadlineTimer.unref?.();
            }
        }
        // Evaluate state machine transitions
        if (trace.rootEnded) {
            if (trace.activeSpanCount <= 0) {
                trace.state = 'QUIESCING';
                if (trace.quiescingTimer) {
                    clearTimeout(trace.quiescingTimer);
                }
                trace.quiescingTimer = setTimeout(() => {
                    this.flushTrace(traceId);
                }, this.gracePeriodMs);
                trace.quiescingTimer.unref?.();
            }
            else {
                trace.state = 'ROOT_ENDED';
            }
        }
        // If listeners are waiting for in-flight children to complete before ending root span
        if (trace.activeSpanCount <= 1 && trace.childCompletionListeners && trace.childCompletionListeners.length > 0) {
            setImmediate(() => {
                if (trace.activeSpanCount <= 1 && trace.childCompletionListeners && trace.childCompletionListeners.length > 0) {
                    const listeners = trace.childCompletionListeners.splice(0);
                    for (const listener of listeners) {
                        try {
                            listener();
                        }
                        catch (err) {
                            getLogger().error('Error in childCompletionListener', { error: err });
                        }
                    }
                }
            });
        }
    }
    /**
     * Explicitly notify aggregator that root server span has ended.
     */
    onRootEnd(traceId) {
        this.onSpanEnd(traceId, undefined, true);
    }
    /**
     * Get the count of currently in-flight spans for a trace.
     */
    getActiveSpanCount(traceId) {
        if (!traceId)
            return 0;
        const trace = this.pending.get(traceId);
        return trace ? trace.activeSpanCount : 0;
    }
    /**
     * Register a callback to be invoked when all active child spans for a trace complete.
     * If there are currently no active child spans (activeSpanCount <= 1), invokes callback after setImmediate.
     * Includes a safety timeout to guarantee execution even if child spans fail to end.
     */
    waitForActiveChildren(traceId, callback, maxWaitMs = 5000) {
        if (!traceId) {
            callback();
            return;
        }
        const trace = this.pending.get(traceId);
        if (!trace || trace.activeSpanCount <= 1) {
            setImmediate(() => {
                const t = this.pending.get(traceId);
                if (!t || t.activeSpanCount <= 1) {
                    callback();
                }
                else {
                    this.waitForActiveChildren(traceId, callback, maxWaitMs);
                }
            });
            return;
        }
        if (!trace.childCompletionListeners) {
            trace.childCompletionListeners = [];
        }
        let invoked = false;
        const wrappedCallback = () => {
            if (invoked)
                return;
            invoked = true;
            clearTimeout(safetyTimer);
            callback();
        };
        trace.childCompletionListeners.push(wrappedCallback);
        const safetyTimer = setTimeout(() => {
            getLogger().warn('waitForActiveChildren reached safety timeout; invoking callback', {
                traceId,
                activeSpanCount: trace.activeSpanCount,
                maxWaitMs,
            });
            wrappedCallback();
        }, maxWaitMs);
        safetyTimer.unref?.();
    }
    /**
     * Add a span event to the aggregator.
     *
     * Buffers the span by traceId. Rejects spans belonging to finalized traces
     * to guarantee no trace resurrection.
     *
     * @param spanEvent - The flat span event from PipelineSpanExporter
     */
    addSpan(spanEvent) {
        const traceId = spanEvent.traceId;
        const spanId = spanEvent.spanId;
        const parentSpanId = spanEvent.parentSpanId;
        if (!traceId || !spanId)
            return;
        // Protection: No trace resurrection!
        if (this.finalizedTraces.has(traceId)) {
            getLogger().debug('Late span arrived after trace finalized — dropping to prevent resurrection', {
                traceId,
                spanId,
                spanName: spanEvent.name,
            });
            return;
        }
        let trace = this.pending.get(traceId);
        if (!trace) {
            if (this.pending.size >= this.maxPendingTraces) {
                this.evictOldest();
            }
            trace = {
                traceId,
                state: 'OPEN',
                activeSpanCount: 0,
                rootEnded: false,
                lastActivityAt: Date.now(),
                finalizationDeadline: null,
                spans: new Map(),
                rootSpan: null,
                createdAt: Date.now(),
                quiescingTimer: null,
                deadlineTimer: null,
            };
            this.pending.set(traceId, trace);
        }
        trace.spans.set(spanId, spanEvent);
        trace.lastActivityAt = Date.now();
        // Root span detection
        if (!parentSpanId) {
            trace.rootSpan = spanEvent;
            trace.rootEnded = true;
            if (!trace.finalizationDeadline) {
                trace.finalizationDeadline = Date.now() + this.maxFinalizationDelayMs;
                trace.deadlineTimer = setTimeout(() => {
                    this.flushTrace(traceId);
                }, this.maxFinalizationDelayMs);
                trace.deadlineTimer.unref?.();
            }
        }
        // If root ended and active child spans are 0, trigger quiescing
        if (trace.rootEnded && trace.activeSpanCount <= 0) {
            trace.state = 'QUIESCING';
            if (trace.quiescingTimer) {
                clearTimeout(trace.quiescingTimer);
            }
            trace.quiescingTimer = setTimeout(() => {
                this.flushTrace(traceId);
            }, this.gracePeriodMs);
            trace.quiescingTimer.unref?.();
        }
    }
    /**
     * Called by the exporter at the end of a batch process.
     * Ensures the trace is evaluated within the grace period if root has ended.
     */
    flushIfComplete(traceId) {
        const trace = this.pending.get(traceId);
        if (!trace || !trace.rootEnded)
            return;
        if (trace.activeSpanCount <= 0) {
            trace.state = 'QUIESCING';
            if (trace.quiescingTimer)
                clearTimeout(trace.quiescingTimer);
            trace.quiescingTimer = setTimeout(() => {
                this.flushTrace(traceId);
            }, this.gracePeriodMs);
            trace.quiescingTimer.unref?.();
        }
    }
    /**
     * Immediately flush a specific trace without waiting for the grace period.
     * Useful for testing and synchronous completion scenarios.
     */
    flushTraceImmediately(traceId) {
        this.flushTrace(traceId);
    }
    /**
     * Flush all pending traces (for shutdown or test tear-down).
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
    /**
     * Get the current state of a trace.
     */
    getTraceState(traceId) {
        if (this.finalizedTraces.has(traceId))
            return 'FINALIZED';
        const trace = this.pending.get(traceId);
        return trace ? trace.state : 'UNKNOWN';
    }
    // ─── Private ──────────────────────────────────────────────────────────────
    /**
     * Build the span tree, evaluate tail-sampling, and emit or discard the trace.
     */
    flushTrace(traceId) {
        const trace = this.pending.get(traceId);
        if (!trace)
            return;
        if (trace.quiescingTimer) {
            clearTimeout(trace.quiescingTimer);
            trace.quiescingTimer = null;
        }
        if (trace.deadlineTimer) {
            clearTimeout(trace.deadlineTimer);
            trace.deadlineTimer = null;
        }
        if (trace.childCompletionListeners && trace.childCompletionListeners.length > 0) {
            const listeners = trace.childCompletionListeners.splice(0);
            for (const listener of listeners) {
                try {
                    listener();
                }
                catch { }
            }
        }
        trace.state = 'FINALIZED';
        // Remove from pending before processing to prevent re-entry
        this.pending.delete(traceId);
        this.markFinalized(traceId);
        // Clean up span duration tracker after a grace period so BatchSpanProcessor (2000ms delay)
        // can complete its export pass without losing child intervals.
        setTimeout(() => {
            try {
                spanDurationTracker.cleanupTrace(traceId);
            }
            catch { }
        }, 10000).unref?.();
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
            // Build the tree: Index children by parentSpanId once (O(n))
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
            const visitedSpanIds = new Set();
            const rootAggregated = this.buildTree(rootSpanEvent, childrenByParent, visitedSpanIds);
            // Ensure all collected spans are included in the trace tree even if an intermediate parent was dropped or filtered upstream
            if (visitedSpanIds.size < spans.length) {
                let unvisited = spans.filter(s => !visitedSpanIds.has(s.spanId));
                while (unvisited.length > 0) {
                    const unvisitedIds = new Set(unvisited.map(s => s.spanId));
                    let nextBatch = unvisited.filter(s => {
                        const pid = s.parentSpanId;
                        return !pid || !unvisitedIds.has(pid);
                    });
                    if (nextBatch.length === 0) {
                        nextBatch = [unvisited.reduce((earliest, s) => {
                                const eStart = earliest.startTime ?? 0;
                                const sStart = s.startTime ?? 0;
                                return sStart < eStart ? s : earliest;
                            })];
                    }
                    nextBatch.sort((a, b) => (a.startTime ?? 0) - (b.startTime ?? 0));
                    for (const orphan of nextBatch) {
                        if (!visitedSpanIds.has(orphan.spanId)) {
                            const orphanTree = this.buildTree(orphan, childrenByParent, visitedSpanIds);
                            rootAggregated.children.push(orphanTree);
                        }
                    }
                    unvisited = spans.filter(s => !visitedSpanIds.has(s.spanId));
                }
                rootAggregated.children.sort((a, b) => a.startTime - b.startTime);
            }
            // Calculate total duration from root (or max child end minus min start)
            let totalDuration = rootSpanEvent.duration ?? 0;
            if (spans.length > 1) {
                const minStart = spans.reduce((min, s) => Math.min(min, s.startTime ?? min), rootSpanEvent.startTime ?? 0);
                const maxEnd = spans.reduce((max, s) => Math.max(max, s.endTime ?? max), rootSpanEvent.endTime ?? 0);
                if (maxEnd > minStart) {
                    totalDuration = Math.max(totalDuration, maxEnd - minStart);
                }
            }
            // Tail-sampling decision:
            // 1. Was root head-sampled?
            const isHeadSampled = Boolean(rootSpanEvent['isSampled'] ??
                (rootSpanEvent.traceFlags !== undefined ? (rootSpanEvent.traceFlags & 1) === 1 : false));
            // 2. Did ANY span in the trace encounter an error or exception?
            const hasError = spans.some(s => s.status === 'error' ||
                (Array.isArray(s.events) && s.events.some((e) => e.name === 'exception')));
            // 3. Did total duration exceed the slow trace threshold?
            const isSlow = totalDuration >= this.slowTraceThresholdMs;
            // Tail-sampling rule: keep if head-sampled, has errors, or is slow
            const shouldKeep = isHeadSampled || hasError || isSlow;
            if (!shouldKeep) {
                logger.debug('Trace dropped by tail sampling (unsampled, no errors, normal duration)', {
                    traceId,
                    isHeadSampled,
                    hasError,
                    isSlow,
                    totalDuration,
                    spanCount: spans.length,
                });
                return;
            }
            const isTailPromoted = !isHeadSampled && (hasError || isSlow);
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
                tailSampled: isTailPromoted,
                hasError,
                isSlow,
                __pulseInternal: true,
            };
            // If this trace was unsampled at head time but promoted by tail-sampling,
            // also emit the individual spans marked with tailSampled so they pass pipeline checks.
            if (isTailPromoted) {
                for (const span of spans) {
                    try {
                        const spanToEmit = { ...span, tailSampled: true, __pulseInternal: true };
                        processEvent(spanToEmit);
                    }
                    catch { }
                }
            }
            // Emit the aggregated trace event
            processEvent(traceDocument);
            logger.debug('Trace aggregated and emitted', {
                traceId,
                spanCount: spans.length,
                isPartial,
                totalDuration,
                tailSampled: isTailPromoted,
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
    buildTree(rootEvent, childrenByParent, visited) {
        const rootSpanId = rootEvent.spanId;
        if (visited) {
            visited.add(rootSpanId);
        }
        // Find direct children of this span — O(1) lookup
        const rawChildren = childrenByParent.get(rootSpanId) ?? [];
        const children = rawChildren
            .filter(child => !visited || !visited.has(child.spanId))
            .map(child => this.buildTree(child, childrenByParent, visited));
        const rawStartTime = rootEvent.startTime;
        const rawEndTime = rootEvent.endTime;
        let startTime = rawStartTime;
        let endTime = rawEndTime;
        if (children.length > 0) {
            for (const child of children) {
                if (child.startTime < startTime)
                    startTime = child.startTime;
                if (child.endTime > endTime)
                    endTime = child.endTime;
            }
        }
        const duration = Math.max(rootEvent.duration ?? 0, endTime - startTime);
        return {
            spanId: rootSpanId,
            traceId: rootEvent.traceId,
            parentSpanId: rootEvent.parentSpanId,
            name: rootEvent.name,
            kind: rootEvent.kind,
            startTime,
            endTime,
            duration,
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
        const oldestTraceId = this.pending.keys().next().value;
        if (oldestTraceId) {
            const trace = this.pending.get(oldestTraceId);
            if (trace?.quiescingTimer) {
                clearTimeout(trace.quiescingTimer);
                trace.quiescingTimer = null;
            }
            if (trace?.deadlineTimer) {
                clearTimeout(trace.deadlineTimer);
                trace.deadlineTimer = null;
            }
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
