import { SDKError } from './errors.js'

export interface RetryDecision {
  readonly retryable: boolean
  readonly permanent: boolean
  readonly reason: string
  readonly retryAfterMs?: number | undefined
}

/**
 * Authoritative central classification for control-plane errors.
 * Single source of truth used across initial init(), background recovery,
 * and runtime config refresh.
 */
export function classifyError(error: unknown): RetryDecision {
  if (!error) {
    return { retryable: false, permanent: true, reason: 'unknown_null_error' }
  }

  if (error instanceof SDKError) {
    if (error.code === 'NETWORK_ERROR') {
      return { retryable: true, permanent: false, reason: 'network_error' }
    }

    if (error.code === 'INVALID_JSON') {
      const status = error.context['statusCode']
      if (typeof status === 'number' && (status >= 500 || status === 408 || status === 425 || status === 429)) {
        return { retryable: true, permanent: false, reason: `http_${status}_transient_invalid_json` }
      }
      return { retryable: false, permanent: true, reason: 'invalid_json' }
    }

    if (
      error.code === 'INVALID_INIT_RESPONSE' ||
      error.code === 'INVALID_REMOTE_CONFIG' ||
      error.code === 'INVALID_INIT_OPTIONS' ||
      error.code === 'INVALID_API_KEY' ||
      error.code === 'SDK_API_KEY_MISSING' ||
      error.code === 'SDK_ALREADY_INITIALIZED' ||
      error.code === 'INVALID_URL'
    ) {
      return { retryable: false, permanent: true, reason: error.code.toLowerCase() }
    }

    if (error.code === 'HTTP_ERROR') {
      const status = error.context['statusCode']
      const retryAfterMs = typeof error.context['retryAfterMs'] === 'number'
        ? error.context['retryAfterMs']
        : undefined

      if (typeof status === 'number') {
        if (status === 401 || status === 403) {
          return { retryable: false, permanent: true, reason: `http_${status}_auth_forbidden`, retryAfterMs }
        }
        if (status === 404) {
          return { retryable: false, permanent: true, reason: 'http_404_not_found', retryAfterMs }
        }
        if (status === 400) {
          return { retryable: false, permanent: true, reason: 'http_400_bad_request', retryAfterMs }
        }
        if (status === 408 || status === 425 || status === 429 || status >= 500) {
          return { retryable: true, permanent: false, reason: `http_${status}`, retryAfterMs }
        }
        if (status >= 400 && status < 500) {
          return { retryable: false, permanent: true, reason: `http_${status}_client_error`, retryAfterMs }
        }
      }
    }
  }

  if (error instanceof TypeError && /fetch|network|getaddrinfo|econnrefused/i.test(error.message)) {
    return { retryable: true, permanent: false, reason: 'fetch_network_error' }
  }

  const message = error instanceof Error ? error.message : String(error)
  if (/econnrefused|etimedout|enotfound|abort/i.test(message)) {
    return { retryable: true, permanent: false, reason: 'transient_system_error' }
  }

  return { retryable: false, permanent: true, reason: 'unclassified_error' }
}

export function isRetryableError(error: unknown): boolean {
  return classifyError(error).retryable
}

export function isPermanentError(error: unknown): boolean {
  return classifyError(error).permanent
}
