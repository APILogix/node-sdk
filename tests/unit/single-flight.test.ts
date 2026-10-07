import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { SingleFlight } from '../../src/core/single-flight.js'
import { init, shutdown } from '../../src/index.js'
import { client } from '../../src/core/client.js'
import { TEST_REMOTE_CONFIG } from '../fixtures/remote-config.js'

describe('SingleFlight Coordinator', () => {
  it('deduplicates concurrent operations into a single execution', async () => {
    const coordinator = new SingleFlight<string>()
    let calls = 0

    const runOp = () =>
      coordinator.execute(async () => {
        calls++
        await new Promise(resolve => setTimeout(resolve, 50))
        return 'success'
      })

    assert.equal(coordinator.isInFlight(), false)
    const promises = [runOp(), runOp(), runOp(), runOp()]
    assert.equal(coordinator.isInFlight(), true)

    const results = await Promise.all(promises)
    assert.deepEqual(results, ['success', 'success', 'success', 'success'])
    assert.equal(calls, 1, 'underlying operation must run exactly once')
    assert.equal(coordinator.isInFlight(), false)

    // After completion, a new execution runs again
    const subsequent = await runOp()
    assert.equal(subsequent, 'success')
    assert.equal(calls, 2)
  })

  it('propagates errors to all concurrent callers and resets in-flight status', async () => {
    const coordinator = new SingleFlight<string>()
    let calls = 0

    const runOp = () =>
      coordinator.execute(async () => {
        calls++
        await new Promise(resolve => setTimeout(resolve, 20))
        throw new Error('boom')
      })

    const p1 = runOp()
    const p2 = runOp()
    assert.equal(coordinator.isInFlight(), true)

    await assert.rejects(p1, /boom/)
    await assert.rejects(p2, /boom/)
    assert.equal(calls, 1)
    assert.equal(coordinator.isInFlight(), false)
  })

  it('shares single-flight promise across concurrent init() calls', async () => {
    const originalFetch = globalThis.fetch
    let fetchCalls = 0
    globalThis.fetch = async () => {
      fetchCalls++
      await new Promise(resolve => setTimeout(resolve, 30))
      return new Response(JSON.stringify({
        success: true,
        projectId: TEST_REMOTE_CONFIG.sdk.projectId,
        environment: TEST_REMOTE_CONFIG.sdk.environment,
        release: TEST_REMOTE_CONFIG.sdk.release,
        config: TEST_REMOTE_CONFIG,
      }), { headers: { 'content-type': 'application/json' } })
    }

    try {
      const calls = Array.from({ length: 10 }, () =>
        init({ apiKey: 'single-flight-key', initTimeoutMs: 500, handleSignals: false })
      )
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(client.isInFlight(), true)
      const results = await Promise.all(calls)
      assert.equal(fetchCalls, 1)
      assert.ok(results.every(r => r?.sdk.projectId === TEST_REMOTE_CONFIG.sdk.projectId))
      assert.equal(client.isInFlight(), false)
    } finally {
      await shutdown(500)
      globalThis.fetch = originalFetch
    }
  })
})
