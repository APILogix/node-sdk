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
import type { EventMetadata } from '../types/event.js';
/** A span with its reconstructed children hierarchy. */
export interface AggregatedSpan {
    readonly spanId: string;
    readonly traceId?: string | undefined;
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
    readonly tailSampled?: boolean | undefined;
    readonly hasError?: boolean | undefined;
    readonly isSlow?: boolean | undefined;
    /** Internal marker for event pipeline routing during shutdown flush. */
    readonly __pulseInternal: true;
}
export type TraceState = 'OPEN' | 'ROOT_ENDED' | 'QUIESCING' | 'FINALIZED';
export interface TraceAggregatorConfig {
    /**
     * Maximum number of pending traces in the buffer.
     * When exceeded, the oldest trace is evicted and flushed as partial.
     * Default: 2000
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
    /**
     * Grace period in milliseconds for quiescing after active spans hit zero and root ended.
     * Default: 100
     */
    readonly gracePeriodMs?: number;
    /**
     * Maximum finalization delay in milliseconds from root arrival (hard safety bound).
     * Default: 250
     */
    readonly maxFinalizationDelayMs?: number;
    /**
     * Latency threshold in milliseconds above which an unsampled trace is retained by tail-sampling.
     * Default: 1000 (1 second)
     */
    readonly slowTraceThresholdMs?: number;
}
export declare class TraceAggregator {
    private readonly pending;
    private readonly finalizedTraces;
    private readonly finalizedOrder;
    private readonly maxFinalizedHistory;
    private readonly maxPendingTraces;
    private readonly orphanTimeoutMs;
    private readonly sweepIntervalMs;
    private readonly gracePeriodMs;
    private readonly maxFinalizationDelayMs;
    private readonly slowTraceThresholdMs;
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
     * Record that a trace has been finalized.
     * Protects against resurrecting finalized traces into duplicate partial traces.
     */
    private markFinalized;
    /**
     * Check whether a trace has already been finalized.
     */
    isFinalized(traceId: string): boolean;
    /**
     * Invoked synchronously via SpanProcessor.onStart() when a span begins execution.
     * Increments activeSpanCount and tracks activity.
     * Protects against resurrecting finalized traces.
     */
    onSpanStart(traceId: string, spanId?: string): void;
    /**
     * Invoked synchronously via SpanProcessor.onEnd() when a span completes execution.
     * Decrements activeSpanCount and evaluates state transition:
     * ROOT_ENDED -> QUIESCING -> FINALIZED
     */
    onSpanEnd(traceId: string, spanId?: string, isRoot?: boolean): void;
    /**
     * Explicitly notify aggregator that root server span has ended.
     */
    onRootEnd(traceId: string): void;
    /**
     * Get the count of currently in-flight spans for a trace.
     */
    getActiveSpanCount(traceId: string): number;
    /**
     * Register a callback to be invoked when all active child spans for a trace complete.
     * If there are currently no active child spans (activeSpanCount <= 1), invokes callback after setImmediate.
     * Includes a safety timeout to guarantee execution even if child spans fail to end.
     */
    waitForActiveChildren(traceId: string, callback: () => void, maxWaitMs?: number): void;
    /**
     * Add a span event to the aggregator.
     *
     * Buffers the span by traceId. Rejects spans belonging to finalized traces
     * to guarantee no trace resurrection.
     *
     * @param spanEvent - The flat span event from PipelineSpanExporter
     */
    addSpan(spanEvent: Record<string, unknown>): void;
    /**
     * Called by the exporter at the end of a batch process.
     * Ensures the trace is evaluated within the grace period if root has ended.
     */
    flushIfComplete(traceId: string): void;
    /**
     * Immediately flush a specific trace without waiting for the grace period.
     * Useful for testing and synchronous completion scenarios.
     */
    flushTraceImmediately(traceId: string): void;
    /**
     * Flush all pending traces (for shutdown or test tear-down).
     * Emits whatever is buffered, marking incomplete traces as partial.
     */
    flushAll(): void;
    /**
     * Get the number of pending traces in the buffer.
     */
    get pendingCount(): number;
    /**
     * Get the current state of a trace.
     */
    getTraceState(traceId: string): TraceState | 'UNKNOWN';
    /**
     * Build the span tree, evaluate tail-sampling, and emit or discard the trace.
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
