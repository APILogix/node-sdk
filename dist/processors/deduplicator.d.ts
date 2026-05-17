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
    private suppressionWindowMs;
    private maxEntries;
    private cleanupTimer;
    private suppressedCount;
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
     */
    isDuplicate(fingerprint: string): boolean;
    /**
     * Get deduplication statistics.
     */
    getStats(): {
        trackedErrors: number;
        suppressedCount: number;
        oldestEntry: number | null;
        newestEntry: number | null;
    };
    /**
     * Reset all deduplication state.
     */
    reset(): void;
    private cleanup;
    private evictIfNecessary;
}
export declare const errorDeduplicator: ErrorDeduplicator;
export { ErrorDeduplicator };
//# sourceMappingURL=deduplicator.d.ts.map