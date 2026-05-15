import { SDKError, toError } from "../core/errors.js"

export interface RetryOptions {
  retries: number
  baseDelayMs?: number
  maxDelayMs?: number
  retryable?: (error: Error) => boolean
  onRetry?: (context: { error: Error; attempt: number; nextAttempt: number; maxAttempts: number; nextRetryDelayMs: number }) => void
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

      const nextRetryDelayMs = backoffWithJitter(baseDelayMs, maxDelayMs, attempt)
      options.onRetry?.({
        error: lastError,
        attempt: attempt + 1,
        nextAttempt: attempt + 2,
        maxAttempts: retries + 1,
        nextRetryDelayMs,
      })
      await sleep(nextRetryDelayMs)
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
