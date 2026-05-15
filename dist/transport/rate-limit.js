/**
 * Rate limiters for protecting transport layer from burst storms.
 *
 * Two implementations:
 * 1. TokenBucketRateLimiter — smooth rate limiting with burst capacity
 * 2. SlidingWindowRateLimiter — count-based with fixed time window
 */
/**
 * Token bucket rate limiter.
 * Allows bursts up to `capacity`, then throttles to `refillRate` per second.
 * Used to prevent send storms in the transport layer.
 */
export class TokenBucketRateLimiter {
    tokens;
    capacity;
    refillRate;
    lastRefillTime;
    constructor(options) {
        this.capacity = Math.max(1, Math.floor(options.capacity));
        this.refillRate = Math.max(0.1, options.refillRate);
        this.tokens = this.capacity;
        this.lastRefillTime = Date.now();
    }
    tryAcquire() {
        this.refill();
        if (this.tokens < 1) {
            return false;
        }
        this.tokens -= 1;
        return true;
    }
    getState() {
        this.refill();
        return {
            type: 'token_bucket',
            available: Math.floor(this.tokens),
            capacity: this.capacity,
            isLimited: this.tokens < 1,
        };
    }
    reset() {
        this.tokens = this.capacity;
        this.lastRefillTime = Date.now();
    }
    refill() {
        const now = Date.now();
        const elapsedSeconds = (now - this.lastRefillTime) / 1000;
        const newTokens = elapsedSeconds * this.refillRate;
        this.tokens = Math.min(this.capacity, this.tokens + newTokens);
        this.lastRefillTime = now;
    }
}
/**
 * Sliding window rate limiter.
 * Counts requests within a fixed time window.
 * More predictable than token bucket but less bursty.
 */
export class SlidingWindowRateLimiter {
    maxRequests;
    windowMs;
    timestamps = [];
    constructor(options) {
        this.maxRequests = Math.max(1, Math.floor(options.maxRequests));
        this.windowMs = Math.max(100, Math.floor(options.windowMs));
    }
    tryAcquire() {
        const now = Date.now();
        this.pruneExpired(now);
        if (this.timestamps.length >= this.maxRequests) {
            return false;
        }
        this.timestamps.push(now);
        return true;
    }
    getState() {
        this.pruneExpired(Date.now());
        return {
            type: 'sliding_window',
            available: this.maxRequests - this.timestamps.length,
            capacity: this.maxRequests,
            isLimited: this.timestamps.length >= this.maxRequests,
        };
    }
    reset() {
        this.timestamps.length = 0;
    }
    pruneExpired(now) {
        const cutoff = now - this.windowMs;
        while (this.timestamps.length > 0 && (this.timestamps[0] ?? now) < cutoff) {
            this.timestamps.shift();
        }
    }
}
//# sourceMappingURL=rate-limit.js.map