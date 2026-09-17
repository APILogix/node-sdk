/**
 * Shutdown and reinit behavior tests for the SDK lifecycle module.
 *
 * Covers the contract that the shutdown sequence must:
 *   1. Destroy ConfigManager singleton (clear timers + listeners + instance).
 *   2. Remove process signal handlers (SIGTERM/SIGINT).
 *   3. Reset the auto-instrumentation guard symbol.
 *   4. Allow a clean re-init() afterwards with no carry-over state.
 *   5. Be idempotent — concurrent and sequential calls share or no-op cleanly.
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'

import {
  shutdown,
  registerSignalHandlers,
  resetSignalHandlers,
  isSDKShuttingDown,
  onBeforeShutdown,
  waitForShutdownCompletion,
} from '../../src/core/lifecycle.js'
import { ConfigManager } from '../../src/core/config-manager.js'
import { resetAutoInstrumentations } from '../../src/instrumentation/auto-instrument.js'
import { client } from '../../src/core/client.js'

const INSTRUMENTATION_GUARD = Symbol.for('pulse-sdk.auto-instrumentation.registered')

interface InstrumentationGlobal {
  [INSTRUMENTATION_GUARD]?: boolean
}

const globalAny = globalThis as typeof globalThis & InstrumentationGlobal

function listenerCount(signal: NodeJS.Signals): number {
  return process.listeners(signal).length
}

async function fullCleanup(): Promise<void> {
  ConfigManager.reset()
  resetSignalHandlers()
  resetAutoInstrumentations()
  client.clear()
}

describe('SDK Lifecycle — shutdown and reinit', () => {
  beforeEach(async () => {
    await fullCleanup()
  })

  afterEach(async () => {
    await fullCleanup()
  })

  it('destroys the ConfigManager singleton', async () => {
    const before = ConfigManager.getInstance()
    assert.equal(before.isDestroyed(), false)

    const result = await shutdown(2_000)
    assert.equal(result.timedOut, false)

    // Old instance must be destroyed.
    assert.equal(before.isDestroyed(), true)

    // Calling getInstance() must return a fresh instance, not the old one.
    const after = ConfigManager.getInstance()
    assert.notEqual(after, before)
    assert.equal(after.isDestroyed(), false)
  })

  it('removes SIGTERM and SIGINT process listeners', async () => {
    const sigtermBaseline = listenerCount('SIGTERM')
    const sigintBaseline = listenerCount('SIGINT')

    registerSignalHandlers()
    assert.equal(listenerCount('SIGTERM'), sigtermBaseline + 1)
    assert.equal(listenerCount('SIGINT'), sigintBaseline + 1)

    await shutdown(2_000)

    assert.equal(listenerCount('SIGTERM'), sigtermBaseline)
    assert.equal(listenerCount('SIGINT'), sigintBaseline)
  })

  it('does not stack signal handlers across reinit cycles', async () => {
    const sigtermBaseline = listenerCount('SIGTERM')

    for (let cycle = 0; cycle < 3; cycle++) {
      registerSignalHandlers()
      await shutdown(2_000)
    }

    // After three full cycles, no leftover handlers.
    assert.equal(listenerCount('SIGTERM'), sigtermBaseline)
  })

  it('clears the auto-instrumentation guard so the next init can re-register', async () => {
    globalAny[INSTRUMENTATION_GUARD] = true

    await shutdown(2_000)

    assert.equal(globalAny[INSTRUMENTATION_GUARD], undefined)
  })

  it('isSDKShuttingDown reports the correct state across the lifecycle', async () => {
    assert.equal(isSDKShuttingDown(), false)

    const inflight = shutdown(2_000)
    assert.equal(isSDKShuttingDown(), true)
    await inflight

    assert.equal(isSDKShuttingDown(), false)
  })

  it('concurrent shutdown calls share a single in-flight shutdown', async () => {
    const a = shutdown(2_000)
    const b = shutdown(2_000)
    const c = shutdown(2_000)

    const [resA, resB, resC] = await Promise.all([a, b, c])

    // All three calls share the same result reference (no duplicate run).
    assert.equal(resA, resB)
    assert.equal(resB, resC)
  })

  it('sequential shutdown calls are independent and idempotent', async () => {
    const first = await shutdown(2_000)
    const second = await shutdown(2_000)

    assert.ok(first)
    assert.ok(second)
    // Each sequential call returns a distinct ShutdownResult value.
    assert.notEqual(first, second)
  })

  it('returns at the caller deadline while cleanup retains ownership', async () => {
    onBeforeShutdown(() => new Promise(resolve => setTimeout(resolve, 150)))
    const startedAt = Date.now()
    const result = await shutdown(15)

    assert.equal(result.timedOut, true)
    assert.ok(Date.now() - startedAt < 120, `shutdown exceeded deadline: ${Date.now() - startedAt}ms`)
    assert.equal(isSDKShuttingDown(), true)

    await waitForShutdownCompletion()
    assert.equal(isSDKShuttingDown(), false)
  })

  it('shutdown returns a structured result with completed/timedOut/stepErrors', async () => {
    const result = await shutdown(2_000)

    assert.equal(typeof result.completed, 'boolean')
    assert.equal(typeof result.timedOut, 'boolean')
    assert.equal(typeof result.durationMs, 'number')
    assert.equal(typeof result.remainingEvents, 'number')
    assert.equal(typeof result.deadLetterCount, 'number')
    assert.ok(Array.isArray(result.stepErrors))
    assert.ok(result.durationMs >= 0)
  })
})
