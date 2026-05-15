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
}
export declare function retry<T>(operation: () => Promise<T>, options: RetryOptions): Promise<T>;
//# sourceMappingURL=retry.d.ts.map