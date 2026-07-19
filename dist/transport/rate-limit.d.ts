/**
 * Rate limiters for protecting transport layer from burst storms.
 *
 * Two implementations:
 * 1. TokenBucketRateLimiter — smooth rate limiting with burst capacity
 * 2. SlidingWindowRateLimiter — count-based with fixed time window
 */
export interface RateLimiter {
    /** Attempt to acquire a permit. Returns true if allowed, false if rate-limited. */
    tryAcquire(): boolean;
    /** Get current rate limiter state for observability. */
    getState(): RateLimiterState;
    /** Reset the rate limiter to full capacity. */
    reset(): void;
}
export interface RateLimiterState {
    readonly type: 'token_bucket' | 'sliding_window';
    readonly available: number;
    readonly capacity: number;
    readonly isLimited: boolean;
}
export interface TokenBucketOptions {
    /** Maximum number of tokens (burst capacity). */
    readonly capacity: number;
    /** Tokens added per second. */
    readonly refillRate: number;
}
/**
 * Token bucket rate limiter.
 * Allows bursts up to `capacity`, then throttles to `refillRate` per second.
 * Used to prevent send storms in the transport layer.
 */
export declare class TokenBucketRateLimiter implements RateLimiter {
    private tokens;
    private readonly capacity;
    private readonly refillRate;
    private lastRefillTime;
    constructor(options: TokenBucketOptions);
    tryAcquire(): boolean;
    getState(): RateLimiterState;
    reset(): void;
    private refill;
}
export interface SlidingWindowOptions {
    /** Maximum requests allowed within the window. */
    readonly maxRequests: number;
    /** Window size in milliseconds. */
    readonly windowMs: number;
}
/**
 * Sliding window rate limiter.
 * Counts requests within a fixed time window.
 * More predictable than token bucket but less bursty.
 */
export declare class SlidingWindowRateLimiter implements RateLimiter {
    private readonly maxRequests;
    private readonly windowMs;
    private readonly timestamps;
    constructor(options: SlidingWindowOptions);
    tryAcquire(): boolean;
    getState(): RateLimiterState;
    reset(): void;
    private pruneExpired;
}
//# sourceMappingURL=rate-limit.d.ts.map