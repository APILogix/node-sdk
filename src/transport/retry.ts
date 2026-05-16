import { SDKError, toError } from "../core/errors.js"

// ─── Retry Budget ───────────────────────────────────────────────────────────

/**
 * Global retry budget — prevents retry storms by capping concurrent
 * retries across ALL in-flight operations. Without this, 50 failing
 * batches × 3 retries each = 150 concurrent retry attempts hammering
 * a struggling backend.
 */
export class RetryBudget {
  private inFlight = 0
  private totalExhausted = 0

  constructor(private readonly maxConcurrentRetries: number = 10) {}

  /** Try to acquire a retry slot. Returns false if budget exhausted. */
  tryAcquire(): boolean {
    if (this.inFlight >= this.maxConcurrentRetries) {
      this.totalExhausted += 1
      return false
    }
    this.inFlight += 1
    return true
  }

  /** Release a retry slot. */
  release(): void {
    this.inFlight = Math.max(0, this.inFlight - 1)
  }

  /** Get current state for diagnostics. */
  getState(): { inFlight: number; maxConcurrentRetries: number; totalExhausted: number } {
    return {
      inFlight: this.inFlight,
      maxConcurrentRetries: this.maxConcurrentRetries,
      totalExhausted: this.totalExhausted,
    }
  }

  /** Reset all state. */
  reset(): void {
    this.inFlight = 0
    this.totalExhausted = 0
  }
}

/** Singleton retry budget shared across all transport operations. */
export const globalRetryBudget = new RetryBudget(10)

// ─── Retry Options ──────────────────────────────────────────────────────────

export interface RetryOptions {
  retries: number
  baseDelayMs?: number
  maxDelayMs?: number
  retryable?: (error: Error) => boolean
  onRetry?: (context: { error: Error; attempt: number; nextAttempt: number; maxAttempts: number; nextRetryDelayMs: number }) => void
  /** Minimum delay from Retry-After header (overrides backoff if larger). */
  retryAfterMs?: number
  /** Optional retry budget — if exhausted, skips retries. */
  budget?: RetryBudget
}

export async function retry<T>(operation: () => Promise<T>, options: RetryOptions): Promise<T> {
  const retries = Math.max(0, Math.floor(options.retries))
  const baseDelayMs = options.baseDelayMs ?? 250
  const maxDelayMs = options.maxDelayMs ?? 5000
  let lastError: Error | undefined

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      lastError = toError(error)

      if (attempt >= retries || options.retryable?.(lastError) === false) {
        throw lastError
      }

      // Check retry budget before attempting
      if (options.budget && !options.budget.tryAcquire()) {
        throw new SDKError('Retry budget exhausted — too many concurrent retries', 'RETRY_BUDGET_EXHAUSTED', {
          budgetState: options.budget.getState(),
        }, lastError)
      }

      const backoffDelay = backoffWithJitter(baseDelayMs, maxDelayMs, attempt)

      // Auto-extract Retry-After from SDKError context (set by HTTP transport)
      let retryAfterDelay = options.retryAfterMs ?? 0
      if (lastError instanceof SDKError && typeof lastError.context.retryAfterMs === 'number') {
        retryAfterDelay = Math.max(retryAfterDelay, lastError.context.retryAfterMs)
      }

      // Use whichever delay is larger — backoff or server-requested
      const nextRetryDelayMs = Math.max(backoffDelay, retryAfterDelay)

      options.onRetry?.({
        error: lastError,
        attempt: attempt + 1,
        nextAttempt: attempt + 2,
        maxAttempts: retries + 1,
        nextRetryDelayMs,
      })

      try {
        await sleep(nextRetryDelayMs)
      } finally {
        options.budget?.release()
      }
    }
  }

  throw new SDKError("Retry failed without an error", "RETRY_FAILED", {}, lastError)
}

function backoffWithJitter(baseDelayMs: number, maxDelayMs: number, attempt: number) {
  const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt)
  return Math.floor(exponential / 2 + Math.random() * (exponential / 2))
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
