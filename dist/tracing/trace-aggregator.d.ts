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
import type { EventMetadata } from '../types/event.js';
/** A span with its reconstructed children hierarchy. */
export interface AggregatedSpan {
    readonly spanId: string;
    readonly parentSpanId?: string | undefined;
    readonly name: string;
    readonly kind?: string | undefined;
    readonly startTime: number;
    readonly endTime: number;
    readonly duration: number;
    readonly exclusiveDuration?: number | undefined;
    readonly status: string;
    readonly statusMessage?: string | undefined;
    readonly attributes?: Readonly<Record<string, unknown>> | undefined;
    readonly events?: readonly {
        name: string;
        timestamp: number;
        attributes?: Readonly<Record<string, unknown>>;
    }[] | undefined;
    readonly links?: readonly {
        traceId: string;
        spanId: string;
        attributes?: Readonly<Record<string, unknown>>;
    }[] | undefined;
    readonly children: AggregatedSpan[];
}
/** Complete trace document with embedded span tree. */
export interface TraceDocument {
    readonly type: 'trace';
    readonly eventId: string;
    readonly traceId: string;
    readonly rootSpan: AggregatedSpan;
    readonly spanCount: number;
    readonly totalDuration: number;
    readonly isPartial: boolean;
    readonly metadata?: EventMetadata | undefined;
    readonly requestId?: string | undefined;
    readonly sessionId?: string | undefined;
    readonly userId?: string | undefined;
    readonly tenantId?: string | undefined;
    /** Internal marker for event pipeline routing during shutdown flush. */
    readonly __pulseInternal: true;
}
export interface TraceAggregatorConfig {
    /**
     * Maximum number of pending traces in the buffer.
     * When exceeded, the oldest trace is evicted and flushed as partial.
     * Default: 1000
     */
    readonly maxPendingTraces?: number;
    /**
     * Timeout in milliseconds for orphaned traces (root span never arrives).
     * After this timeout, whatever spans are buffered are flushed as a partial trace.
     * Default: 30000 (30 seconds)
     */
    readonly orphanTimeoutMs?: number;
    /**
     * Sweep interval in milliseconds for checking orphaned traces.
     * Default: 10000 (10 seconds)
     */
    readonly sweepIntervalMs?: number;
}
export declare class TraceAggregator {
    private readonly pending;
    private readonly maxPendingTraces;
    private readonly orphanTimeoutMs;
    private readonly sweepIntervalMs;
    private sweepTimer;
    constructor(config?: TraceAggregatorConfig);
    /**
     * Start the background sweep timer for orphaned traces.
     * Must be called after SDK init. Timer is `.unref()`'d so it won't
     * prevent the process from exiting.
     */
    start(): void;
    /**
     * Stop the background sweep timer.
     */
    stop(): void;
    /**
     * Add a span event to the aggregator.
     *
     * If this span is the root (no parentSpanId), it triggers immediate
     * trace assembly and emission. Otherwise, the span is buffered until
     * the root arrives or the orphan timeout fires.
     *
     * @param spanEvent - The flat span event from PipelineSpanExporter
     */
    addSpan(spanEvent: Record<string, unknown>): void;
    /**
     * Flush the trace if its root span has arrived.
     * This is called by the exporter at the end of a batch process to ensure
     * all spans from the same batch are buffered before the trace is assembled.
     */
    flushIfComplete(traceId: string): void;
    /**
     * Flush all pending traces (for shutdown).
     * Emits whatever is buffered, marking incomplete traces as partial.
     */
    flushAll(): void;
    /**
     * Get the number of pending traces in the buffer.
     */
    get pendingCount(): number;
    /**
     * Build the span tree and emit a complete trace event.
     */
    private flushTrace;
    /**
     * Recursively build the span tree using the pre-built parentSpanId →
     * children index. Children lists are already sorted by startTime.
     */
    private buildTree;
    /**
     * Sweep for orphaned traces that have exceeded the timeout.
     */
    private sweepOrphans;
    /**
     * Evict the oldest pending trace to make room for a new one.
     */
    private evictOldest;
}
/**
 * Get or create the singleton TraceAggregator instance.
 */
export declare function getTraceAggregator(config?: TraceAggregatorConfig): TraceAggregator;
/**
 * Reset the singleton (for shutdown/reinit).
 */
export declare function resetTraceAggregator(): void;
