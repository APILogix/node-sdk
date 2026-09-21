/**
 * Span Duration Analysis — computes exclusive/self duration for
 * performance attribution in trace waterfalls.
 *
 * The "exclusive duration" of a span is the wall-clock time spent in the
 * span's own code, excluding time covered by child spans. This enables
 * UI features like:
 *   "DB took 50ms"
 *   "External APIs took 1200ms"
 *   "Business logic took 400ms"
 *
 * Algorithm:
 *   1. Collect all child span intervals [startTime, endTime].
 *   2. Clamp each interval to the parent's boundaries (children that
 *      extend beyond the parent are artifacts of clock drift).
 *   3. Sort intervals by start time.
 *   4. Merge overlapping intervals into a non-overlapping coverage set.
 *   5. Subtract merged coverage from parent duration.
 *
 * This correctly handles:
 *   - Parallel async operations (overlapping children)
 *   - Sequential operations
 *   - Nested children (grandchildren are irrelevant — only direct children matter)
 *   - Children that start before or end after the parent (clamped)
 *   - Empty child lists (exclusive = inclusive)
 *
 * Example:
 *   Parent:  |--------- 200ms ---------|
 *   Child A: |--- 50ms ---|
 *   Child B:        |--- 80ms ---|
 *   Merged:  |------ 100ms ------|       (overlap absorbed)
 *   Self:                         |100ms| → exclusiveDuration = 100ms
 */
/**
 * A time interval representing a child span's coverage within its parent.
 */
export interface SpanInterval {
    readonly startTime: number;
    readonly endTime: number;
}
/**
 * Result of exclusive duration computation.
 */
export interface DurationBreakdown {
    /** Total wall-clock time of the parent span (endTime - startTime). */
    readonly inclusiveDuration: number;
    /** Wall-clock time in the parent's own code, excluding child spans. */
    readonly exclusiveDuration: number;
    /** Total non-overlapping wall-clock time covered by child spans. */
    readonly childDuration: number;
}
export declare function computeExclusiveDuration(parentStartMs: number, parentEndMs: number, childIntervals: ReadonlyArray<SpanInterval>, spanName?: string): DurationBreakdown;
/**
 * In-memory buffer that tracks child span intervals per trace for
 * exclusive duration computation at export time.
 *
 * Design:
 *   - Keyed by traceId (all spans in a trace share a traceId)
 *   - Each entry maps parentSpanId → list of child intervals
 *   - Entries are cleaned up when the trace's root span is exported
 *   - Bounded by max entries to prevent unbounded memory growth
 *
 * Lifecycle:
 *   1. PipelineSpanExporter calls `recordChildInterval()` for every span
 *      that has a parentSpanId.
 *   2. When a span is exported, `getChildIntervals()` retrieves the
 *      buffered children for that span.
 *   3. After the root span is exported, `cleanupTrace()` removes the
 *      entire trace entry.
 */
export declare class SpanDurationTracker {
    /**
     * Max number of traces to track concurrently. Beyond this, oldest
     * traces are evicted to prevent unbounded memory growth.
     */
    private static readonly MAX_TRACES;
    /**
     * Max age (ms) of a trace entry before it's eligible for eviction.
     * Prevents stale entries from accumulating if a root span is never
     * exported (e.g., dropped by cost governor).
     */
    private static readonly MAX_AGE_MS;
    /** Map<traceId, Map<parentSpanId, SpanInterval[]>> */
    private readonly traces;
    /**
     * Record a child span's interval under its parent.
     * Called during span export for every span that has a parentSpanId.
     */
    recordChildInterval(traceId: string, parentSpanId: string, startTime: number, endTime: number): void;
    /**
     * Get buffered child intervals for a specific span.
     * Returns an empty array if no children have been recorded.
     */
    getChildIntervals(traceId: string, spanId: string): ReadonlyArray<SpanInterval>;
    /**
     * Remove all data for a trace. Call after the root span is exported
     * to free memory.
     */
    cleanupTrace(traceId: string): void;
    /**
     * Evict traces older than MAX_AGE_MS or the oldest entries if still
     * at capacity.
     */
    private evictStaleTraces;
    /** Reset all state — for testing or reinit. @internal */
    reset(): void;
}
/** Singleton instance for the SDK. */
export declare const spanDurationTracker: SpanDurationTracker;
