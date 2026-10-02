export interface RetryDecision {
    readonly retryable: boolean;
    readonly permanent: boolean;
    readonly reason: string;
    readonly retryAfterMs?: number | undefined;
}
/**
 * Authoritative central classification for control-plane errors.
 * Single source of truth used across initial init(), background recovery,
 * and runtime config refresh.
 */
export declare function classifyError(error: unknown): RetryDecision;
export declare function isRetryableError(error: unknown): boolean;
export declare function isPermanentError(error: unknown): boolean;
