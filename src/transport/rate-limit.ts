/**
 * Rate limiters for protecting transport layer from burst storms.
 *
 * Two implementations:
 * 1. TokenBucketRateLimiter — smooth rate limiting with burst capacity
 * 2. SlidingWindowRateLimiter — count-based with fixed time window
 */

// ─── Interface ──────────────────────────────────────────────────────────────

export interface RateLimiter {
  /** Attempt to acquire a permit. Returns true if allowed, false if rate-limited. */
  tryAcquire(): boolean
  /** Get current rate limiter state for observability. */
  getState(): RateLimiterState
  /** Reset the rate limiter to full capacity. */
  reset(): void
}

export interface RateLimiterState {
  readonly type: 'token_bucket' | 'sliding_window'
  readonly available: number
  readonly capacity: number
  readonly isLimited: boolean
}

// ─── Token Bucket ───────────────────────────────────────────────────────────

export interface TokenBucketOptions {
  /** Maximum number of tokens (burst capacity). */
  readonly capacity: number
  /** Tokens added per second. */
  readonly refillRate: number
}

/**
 * Token bucket rate limiter.
 * Allows bursts up to `capacity`, then throttles to `refillRate` per second.
 * Used to prevent send storms in the transport layer.
 */
export class TokenBucketRateLimiter implements RateLimiter {
  private tokens: number
  private readonly capacity: number
  private readonly refillRate: number
  private lastRefillTime: number

  constructor(options: TokenBucketOptions) {
    this.capacity = Number.isFinite(options?.capacity) ? Math.max(1, Math.floor(options.capacity)) : 10
    this.refillRate = Number.isFinite(options?.refillRate) ? Math.max(0.1, options.refillRate) : 1
    this.tokens = this.capacity
    this.lastRefillTime = Date.now()
  }


  tryAcquire(): boolean {
    this.refill()

    if (this.tokens < 1) {
      return false
    }

    this.tokens -= 1
    return true
  }

  getState(): RateLimiterState {
    this.refill()
    return {
      type: 'token_bucket',
      available: Math.floor(this.tokens),
      capacity: this.capacity,
      isLimited: this.tokens < 1,
    }
  }

  reset(): void {
    this.tokens = this.capacity
    this.lastRefillTime = Date.now()
  }

  private refill(): void {
    const now = Date.now()
    const elapsedSeconds = (now - this.lastRefillTime) / 1000
    const newTokens = elapsedSeconds * this.refillRate

    this.tokens = Math.min(this.capacity, this.tokens + newTokens)
    this.lastRefillTime = now
  }
}

// ─── Sliding Window ─────────────────────────────────────────────────────────

export interface SlidingWindowOptions {
  /** Maximum requests allowed within the window. */
  readonly maxRequests: number
  /** Window size in milliseconds. */
  readonly windowMs: number
}

/**
 * Sliding window rate limiter.
 * Counts requests within a fixed time window.
 * More predictable than token bucket but less bursty.
 */
export class SlidingWindowRateLimiter implements RateLimiter {
  private readonly maxRequests: number
  private readonly windowMs: number
  private readonly timestamps: number[] = []

  constructor(options: SlidingWindowOptions) {
    this.maxRequests = Number.isFinite(options?.maxRequests) ? Math.max(1, Math.floor(options.maxRequests)) : 10
    this.windowMs = Number.isFinite(options?.windowMs) ? Math.max(100, Math.floor(options.windowMs)) : 1000
  }

  tryAcquire(): boolean {
    const now = Date.now()
    this.pruneExpired(now)

    if (this.timestamps.length >= this.maxRequests) {
      return false
    }

    this.timestamps.push(now)
    return true
  }

  getState(): RateLimiterState {
    this.pruneExpired(Date.now())
    return {
      type: 'sliding_window',
      available: this.maxRequests - this.timestamps.length,
      capacity: this.maxRequests,
      isLimited: this.timestamps.length >= this.maxRequests,
    }
  }

  reset(): void {
    this.timestamps.length = 0
  }

  private pruneExpired(now: number): void {
    const cutoff = now - this.windowMs
    // Find first non-expired index and splice in one operation — O(n) vs O(n²) shift loop
    let firstValid = 0
    while (firstValid < this.timestamps.length && (this.timestamps[firstValid] ?? now) < cutoff) {
      firstValid++
    }
    if (firstValid > 0) {
      this.timestamps.splice(0, firstValid)
    }
  }
}
