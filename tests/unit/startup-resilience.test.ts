import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { init, shutdown } from '../../src/index.js'
import { client } from '../../src/core/client.js'
import { SerializationPool } from '../../src/transport/serialization-pool.js'
import { TEST_REMOTE_CONFIG } from '../fixtures/remote-config.js'

describe('application startup with unavailable telemetry', () => {
  it('continues after a stalled init and shares the one request across callers', async () => {
    const originalFetch = globalThis.fetch
    const exitCode = process.exitCode
    let calls = 0
    globalThis.fetch = async () => {
      calls++
      return new Promise<Response>(() => {})
    }
    try {
      const results = await Promise.all(Array.from({ length: 20 }, () => init({ apiKey: 'test-key', initTimeoutMs: 100, initRetries: 0 })))
      assert.ok(results.every(result => result === undefined))
      assert.equal(calls, 1)
      assert.equal(client.initialized, false)
      assert.equal(process.exitCode, exitCode)
      assert.equal(SerializationPool.getInstance(), null)
      assert.equal(client.getInitPromise(), null)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('continues immediately after backend pressure rejection without retries', async () => {
    const originalFetch = globalThis.fetch
    let calls = 0
    globalThis.fetch = async () => {
      calls++
      return new Response(JSON.stringify({ error: 'Server busy' }), { status: 503, headers: { 'Retry-After': '10' } })
    }
    try {
      assert.equal(await init({ apiKey: 'test-key', initRetries: 0 }), undefined)
      assert.equal(calls, 1)
      assert.equal(client.initialized, false)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('shares one successful retry sequence across concurrent callers', async () => {
    const originalFetch = globalThis.fetch
    let calls = 0
    globalThis.fetch = async () => {
      calls++
      if (calls === 1) throw new TypeError('temporary network failure')
      return new Response(JSON.stringify({
        success: true,
        projectId: TEST_REMOTE_CONFIG.sdk.projectId,
        environment: TEST_REMOTE_CONFIG.sdk.environment,
        release: TEST_REMOTE_CONFIG.sdk.release,
        config: TEST_REMOTE_CONFIG,
      }), { headers: { 'content-type': 'application/json' } })
    }
    try {
      const results = await Promise.all(Array.from({ length: 20 }, () => init({
        apiKey: 'test-key',
        initTimeoutMs: 500,
        handleSignals: false,
      })))
      assert.equal(calls, 2)
      assert.ok(results.every(result => result?.sdk.projectId === TEST_REMOTE_CONFIG.sdk.projectId))
      assert.equal(client.initialized, true)
    } finally {
      await shutdown(500)
      globalThis.fetch = originalFetch
    }
  })

  it('preserves API key, SDK options, event queue, and bootstrap hooks in dormant state when init fails', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => {
      return new Response(JSON.stringify({ error: 'service unavailable' }), { status: 503 })
    }
    try {
      const res = await init({ apiKey: 'preserved-api-key', initTimeoutMs: 100, initRetries: 0 })
      assert.equal(res, undefined)
      assert.equal(client.initialized, false)
      // Check that client options and API key were preserved
      assert.equal(client.getApiKey(), 'preserved-api-key')
      assert.equal(client.options?.apiKey, 'preserved-api-key')
      assert.equal(client.options?.initTimeoutMs, 100)

      // Check that bootstrap auto-instrumentation hooks were NOT destroyed
      const guardSymbol = Symbol.for('pulse-sdk.auto-instrumentation.registered')
      const bootstrapSymbol = Symbol.for('pulse-sdk.auto-instrumentation.bootstrap')
      const g = globalThis as Record<symbol, unknown>
      assert.equal(g[guardSymbol], true, 'Instrumentation guard must remain true')
      assert.equal(g[bootstrapSymbol], true, 'Bootstrap guard must remain true')
    } finally {
      await shutdown(500)
      globalThis.fetch = originalFetch
    }
  })
})
