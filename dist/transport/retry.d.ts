/**
 * Global retry budget — prevents retry storms by capping concurrent
 * retries across ALL in-flight operations. Without this, 50 failing
 * batches × 3 retries each = 150 concurrent retry attempts hammering
 * a struggling backend.
 */
export declare class RetryBudget {
    private readonly maxConcurrentRetries;
    private inFlight;
    private totalExhausted;
    constructor(maxConcurrentRetries?: number);
    /** Try to acquire a retry slot. Returns false if budget exhausted. */
    tryAcquire(): boolean;
    /** Release a retry slot. */
    release(): void;
    /** Get current state for diagnostics. */
    getState(): {
        inFlight: number;
        maxConcurrentRetries: number;
        totalExhausted: number;
    };
    /** Reset all state. */
    reset(): void;
}
/** Singleton retry budget shared across all transport operations. */
export declare const globalRetryBudget: RetryBudget;
export interface RetryOptions {
    retries: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    retryable?: (error: Error) => boolean;
    onRetry?: (context: {
        error: Error;
        attempt: number;
        nextAttempt: number;
        maxAttempts: number;
        nextRetryDelayMs: number;
    }) => void;
    /** Minimum delay from Retry-After header (overrides backoff if larger). */
    retryAfterMs?: number;
    /** Optional retry budget — if exhausted, skips retries. */
    budget?: RetryBudget;
}
export declare function retry<T>(operation: () => Promise<T>, options: RetryOptions): Promise<T>;
//# sourceMappingURL=retry.d.ts.map