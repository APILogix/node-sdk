import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { LifecycleStateMachine } from '../../src/core/state.js'
import { client } from '../../src/core/client.js'
import { init, shutdown } from '../../src/index.js'
import { TEST_REMOTE_CONFIG } from '../fixtures/remote-config.js'

describe('LifecycleStateMachine', () => {
  it('starts in created state', () => {
    const sm = new LifecycleStateMachine()
    assert.equal(sm.getState(), 'created')
  })

  it('allows valid state transitions', () => {
    const sm = new LifecycleStateMachine()

    // created -> initializing -> initialized
    assert.equal(sm.transition('initializing'), 'initializing')
    assert.equal(sm.transition('initialized'), 'initialized')

    // initialized -> stopping -> stopped
    assert.equal(sm.transition('stopping'), 'stopping')
    assert.equal(sm.transition('stopped'), 'stopped')

    // Reset back to created
    sm.reset()
    assert.equal(sm.getState(), 'created')

    // created -> initializing -> recovering
    assert.equal(sm.transition('initializing'), 'initializing')
    assert.equal(sm.transition('recovering'), 'recovering')

    // recovering -> initializing (retry attempt)
    assert.equal(sm.transition('initializing'), 'initializing')
    assert.equal(sm.transition('recovering'), 'recovering')

    // recovering -> recovering (idempotent / multiple attempts)
    assert.equal(sm.transition('recovering'), 'recovering')

    // recovering -> initialized (recovery succeeded)
    assert.equal(sm.transition('initialized'), 'initialized')
  })

  it('allows recovering -> stopping and recovering -> stopped', () => {
    const sm1 = new LifecycleStateMachine()
    sm1.transition('initializing')
    sm1.transition('recovering')
    assert.equal(sm1.transition('stopping'), 'stopping')
    assert.equal(sm1.transition('stopped'), 'stopped')

    const sm2 = new LifecycleStateMachine()
    sm2.transition('initializing')
    sm2.transition('recovering')
    assert.equal(sm2.transition('stopped'), 'stopped')
  })

  it('rejects invalid state transitions', () => {
    const sm = new LifecycleStateMachine()

    // created -> initialized directly
    assert.throws(() => sm.transition('initialized'), (err: any) => err.code === 'INVALID_STATE_TRANSITION')
    // created -> recovering directly
    assert.throws(() => sm.transition('recovering'), (err: any) => err.code === 'INVALID_STATE_TRANSITION')
    // created -> stopped directly
    assert.throws(() => sm.transition('stopped'), (err: any) => err.code === 'INVALID_STATE_TRANSITION')

    // Move to stopped
    sm.transition('stopping')
    sm.transition('stopped')

    // stopped -> initialized
    assert.throws(() => sm.transition('initialized'), (err: any) => err.code === 'INVALID_STATE_TRANSITION')
    // stopped -> recovering
    assert.throws(() => sm.transition('recovering'), (err: any) => err.code === 'INVALID_STATE_TRANSITION')
    // stopped -> initializing
    assert.throws(() => sm.transition('initializing'), (err: any) => err.code === 'INVALID_STATE_TRANSITION')
  })

  it('transitions SDKClient to recovering when init fails', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => {
      return new Response(JSON.stringify({ error: 'outage' }), { status: 500 })
    }
    try {
      await init({ apiKey: 'state-test-key', initTimeoutMs: 100, initRetries: 0 })
      assert.equal(client.getState(), 'recovering')
      assert.equal(client.initialized, false)
    } finally {
      await shutdown(500)
      globalThis.fetch = originalFetch
    }
  })

  it('transitions SDKClient to initialized when init succeeds', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => {
      return new Response(JSON.stringify({
        success: true,
        projectId: TEST_REMOTE_CONFIG.sdk.projectId,
        environment: TEST_REMOTE_CONFIG.sdk.environment,
        release: TEST_REMOTE_CONFIG.sdk.release,
        config: TEST_REMOTE_CONFIG,
      }), { headers: { 'content-type': 'application/json' } })
    }
    try {
      await init({ apiKey: 'state-test-key', initTimeoutMs: 500, handleSignals: false })
      assert.equal(client.getState(), 'initialized')
      assert.equal(client.initialized, true)
    } finally {
      await shutdown(500)
      globalThis.fetch = originalFetch
    }
  })
})
