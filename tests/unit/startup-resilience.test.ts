import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { init } from '../../src/index.js'
import { client } from '../../src/core/client.js'
import { SerializationPool } from '../../src/transport/serialization-pool.js'

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
      const results = await Promise.all(Array.from({ length: 20 }, () => init({ apiKey: 'test-key', initTimeoutMs: 100 })))
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
      assert.equal(await init({ apiKey: 'test-key' }), undefined)
      assert.equal(calls, 1)
      assert.equal(client.initialized, false)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
