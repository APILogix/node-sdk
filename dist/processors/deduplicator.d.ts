/**
 * Error deduplication — suppresses duplicate errors within a configurable window.
 *
 * Tracks error fingerprints with timestamps and occurrence counts.
 * When the same fingerprint is seen within the suppression window,
 * the duplicate is suppressed and a counter is incremented.
 *
 * Thread-safe for concurrent access via Map operations.
 */
declare class ErrorDeduplicator {
    private entries;
    private replaySeen;
    private readonly maxReplayEntries;
    private suppressionWindowMs;
    private maxEntries;
    private cleanupTimer;
    private suppressedCount;
    private replayDuplicateCount;
    private initialized;
    configure(options?: {
        suppressionWindowMs?: number;
        maxEntries?: number;
    }): void;
    start(): void;
    stop(): void;
    /**
     * Check if an error fingerprint should be suppressed.
     * Returns true if the error is a duplicate within the suppression window.
     *
     * Map insertion order is preserved by ECMAScript spec, so we can rely on
     * `entries.keys().next()` to give us the oldest entry (insertion order),
     * which correlates closely with `lastSeen` because we re-insert on
     * window expiry. This makes eviction O(k) instead of O(n log n).
     */
    isDuplicate(fingerprint: string): boolean;
    /**
     * Get deduplication statistics.
     */
    getStats(): {
        trackedErrors: number;
        suppressedCount: number;
        replayDuplicateCount: number;
        cacheSize: number;
        cacheCapacity: number;
        oldestEntry: number | null;
        newestEntry: number | null;
    };
    /**
     * Check if a replayed event is a duplicate.
     * Uses a separate map keyed by replayId to avoid false suppression.
     */
    isReplayDuplicate(fingerprint: string, replayId: string): boolean;
    /**
     * Reset all deduplication state. Also stops the cleanup timer so a
     * subsequent start() can re-arm it cleanly. Idempotent.
     */
    reset(): void;
    private cleanup;
    /**
     * Evict the oldest entries (by insertion order) when the cache exceeds
     * its capacity. Map iteration is insertion-ordered per the ECMAScript
     * spec, so this is O(k) where k is the eviction count — far cheaper than
     * the previous sort-based eviction.
     */
    private evictIfNecessary;
}
export declare const errorDeduplicator: ErrorDeduplicator;
export { ErrorDeduplicator };
//# sourceMappingURL=deduplicator.d.ts.map