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
 * Compute the exclusive (self) duration of a parent span by subtracting
 * the merged coverage of its direct child span intervals.
 *
 * @param parentStartMs - Parent span start time in milliseconds.
 * @param parentEndMs   - Parent span end time in milliseconds.
 * @param childIntervals - Array of direct child span intervals.
 * @returns Duration breakdown with inclusive, exclusive, and child durations.
 *
 * @example
 * ```ts
 * const result = computeExclusiveDuration(0, 200, [
 *   { startTime: 0, endTime: 50 },
 *   { startTime: 30, endTime: 110 },
 * ])
 * // result.inclusiveDuration === 200
 * // result.childDuration === 110  (merged: 0-110)
 * // result.exclusiveDuration === 90
 * ```
 */
export function computeExclusiveDuration(parentStartMs, parentEndMs, childIntervals) {
    const inclusiveDuration = Math.max(0, parentEndMs - parentStartMs);
    if (childIntervals.length === 0) {
        return { inclusiveDuration, exclusiveDuration: inclusiveDuration, childDuration: 0 };
    }
    // Step 1: Clamp child intervals to parent boundaries and filter invalids
    const clamped = [];
    for (const child of childIntervals) {
        const start = Math.max(child.startTime, parentStartMs);
        const end = Math.min(child.endTime, parentEndMs);
        if (start < end) {
            clamped.push({ start, end });
        }
    }
    if (clamped.length === 0) {
        return { inclusiveDuration, exclusiveDuration: inclusiveDuration, childDuration: 0 };
    }
    // Step 2: Sort by start time (ties broken by earlier end time)
    clamped.sort((a, b) => a.start - b.start || a.end - b.end);
    // Step 3: Merge overlapping intervals
    const merged = [clamped[0]];
    for (let i = 1; i < clamped.length; i++) {
        const current = clamped[i];
        const last = merged[merged.length - 1];
        if (current.start <= last.end) {
            // Overlapping or adjacent — extend the current merged interval
            last.end = Math.max(last.end, current.end);
        }
        else {
            // Non-overlapping — start a new merged interval
            merged.push({ start: current.start, end: current.end });
        }
    }
    // Step 4: Sum merged coverage
    let childDuration = 0;
    for (const interval of merged) {
        childDuration += interval.end - interval.start;
    }
    // Step 5: Exclusive = inclusive - child coverage
    // Guard against floating-point edge cases where child > inclusive
    const exclusiveDuration = Math.max(0, inclusiveDuration - childDuration);
    return { inclusiveDuration, exclusiveDuration, childDuration };
}
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
export class SpanDurationTracker {
    /**
     * Max number of traces to track concurrently. Beyond this, oldest
     * traces are evicted to prevent unbounded memory growth.
     */
    static MAX_TRACES = 10_000;
    /**
     * Max age (ms) of a trace entry before it's eligible for eviction.
     * Prevents stale entries from accumulating if a root span is never
     * exported (e.g., dropped by cost governor).
     */
    static MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes
    /** Map<traceId, Map<parentSpanId, SpanInterval[]>> */
    traces = new Map();
    /**
     * Record a child span's interval under its parent.
     * Called during span export for every span that has a parentSpanId.
     */
    recordChildInterval(traceId, parentSpanId, startTime, endTime) {
        let traceEntry = this.traces.get(traceId);
        if (!traceEntry) {
            // Evict oldest traces if we're at capacity
            if (this.traces.size >= SpanDurationTracker.MAX_TRACES) {
                this.evictStaleTraces();
            }
            traceEntry = { children: new Map(), createdAt: Date.now() };
            this.traces.set(traceId, traceEntry);
        }
        let intervals = traceEntry.children.get(parentSpanId);
        if (!intervals) {
            intervals = [];
            traceEntry.children.set(parentSpanId, intervals);
        }
        intervals.push({ startTime, endTime });
    }
    /**
     * Get buffered child intervals for a specific span.
     * Returns an empty array if no children have been recorded.
     */
    getChildIntervals(traceId, spanId) {
        const traceEntry = this.traces.get(traceId);
        if (!traceEntry)
            return [];
        return traceEntry.children.get(spanId) ?? [];
    }
    /**
     * Remove all data for a trace. Call after the root span is exported
     * to free memory.
     */
    cleanupTrace(traceId) {
        this.traces.delete(traceId);
    }
    /**
     * Evict traces older than MAX_AGE_MS or the oldest entries if still
     * at capacity.
     */
    evictStaleTraces() {
        const now = Date.now();
        const toDelete = [];
        for (const [traceId, entry] of this.traces) {
            if (now - entry.createdAt > SpanDurationTracker.MAX_AGE_MS) {
                toDelete.push(traceId);
            }
        }
        // If stale eviction wasn't enough, remove oldest entries
        if (toDelete.length === 0 && this.traces.size >= SpanDurationTracker.MAX_TRACES) {
            const iterator = this.traces.keys();
            const oldest = iterator.next();
            if (!oldest.done) {
                toDelete.push(oldest.value);
            }
        }
        for (const traceId of toDelete) {
            this.traces.delete(traceId);
        }
    }
    /** Reset all state — for testing or reinit. @internal */
    reset() {
        this.traces.clear();
    }
}
/** Singleton instance for the SDK. */
export const spanDurationTracker = new SpanDurationTracker();
