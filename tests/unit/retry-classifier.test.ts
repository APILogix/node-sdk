import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { classifyError, isRetryableError, isPermanentError } from '../../src/core/retry-classifier.js'
import { SDKError } from '../../src/core/errors.js'

describe('Central Retry Classifier', () => {
  it('classifies network errors as retryable', () => {
    const netErr = new SDKError('Network timeout', 'NETWORK_ERROR', { reason: 'timeout' })
    const decision = classifyError(netErr)
    assert.equal(decision.retryable, true)
    assert.equal(decision.permanent, false)
    assert.equal(isRetryableError(netErr), true)
    assert.equal(isPermanentError(netErr), false)

    const nativeTypeErr = new TypeError('fetch failed: getaddrinfo ENOTFOUND api.pulse.io')
    assert.equal(isRetryableError(nativeTypeErr), true)
  })

  it('classifies transient HTTP status codes as retryable', () => {
    for (const status of [408, 425, 429, 500, 502, 503, 504]) {
      const err = new SDKError('HTTP error', 'HTTP_ERROR', { statusCode: status })
      assert.equal(isRetryableError(err), true, `HTTP ${status} must be retryable`)
      assert.equal(isPermanentError(err), false)
    }

    const rateLimitErr = new SDKError('Rate limited', 'HTTP_ERROR', { statusCode: 429, retryAfterMs: 3000 })
    const decision = classifyError(rateLimitErr)
    assert.equal(decision.retryable, true)
    assert.equal(decision.retryAfterMs, 3000)
  })

  it('classifies authentication and forbidden errors as permanent non-retryable failures', () => {
    for (const status of [401, 403]) {
      const err = new SDKError('Auth error', 'HTTP_ERROR', { statusCode: status })
      assert.equal(isRetryableError(err), false, `HTTP ${status} must not be retryable`)
      assert.equal(isPermanentError(err), true)
    }
  })

  it('classifies 404 not found and 400 bad request as permanent failures', () => {
    for (const status of [400, 404]) {
      const err = new SDKError('Client error', 'HTTP_ERROR', { statusCode: status })
      assert.equal(isRetryableError(err), false, `HTTP ${status} must not be retryable`)
      assert.equal(isPermanentError(err), true)
    }
  })

  it('classifies invalid JSON as permanent failure', () => {
    const jsonErr = new SDKError('Response was not valid JSON', 'INVALID_JSON')
    assert.equal(isRetryableError(jsonErr), false)
    assert.equal(isPermanentError(jsonErr), true)
  })

  it('classifies schema and config validation errors as permanent failures', () => {
    for (const code of ['INVALID_INIT_RESPONSE', 'INVALID_REMOTE_CONFIG', 'INVALID_INIT_OPTIONS', 'SDK_API_KEY_MISSING']) {
      const err = new SDKError('Validation error', code as any)
      assert.equal(isRetryableError(err), false)
      assert.equal(isPermanentError(err), true)
    }
  })
})
