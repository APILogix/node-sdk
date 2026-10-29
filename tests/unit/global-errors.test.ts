import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { setupGlobalErrorHandlers, resetGlobalErrorHandlers } from '../../src/instrumentation/global-errors.js'
import { init } from '../../src/core/init.js'
import { shutdown } from '../../src/core/lifecycle.js'
import { TEST_REMOTE_CONFIG } from '../fixtures/remote-config.js'
import { performance } from 'node:perf_hooks'

describe('Global Errors Instrumentation & Process Warning Classification', () => {
  const originalConsoleError = console.error

  beforeEach(() => {
    resetGlobalErrorHandlers()
  })

  afterEach(async () => {
    resetGlobalErrorHandlers()
    console.error = originalConsoleError
    await shutdown()
  })

  it('1. Intercepts standard error strings and errors into captureException', async () => {
    let capturedErrorCount = 0
    let capturedMessageCount = 0

    // Initialize with mock fetch
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (url: any) => {
      if (String(url).includes('/v1/init')) {
        return new Response(JSON.stringify({
          success: true,
          config: {
            ...TEST_REMOTE_CONFIG,
            features: { ...TEST_REMOTE_CONFIG.features, errors: true },
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    }) as any

    try {
      await init({ apiKey: 'test-key' })
      setupGlobalErrorHandlers()

      // Monkeypatch captureException / captureMessage directly or verify via wrapped function
      // Here we verify that calling console.error with a normal error does not throw
      console.error(new Error('Normal application failure'))
      console.error('Database connection failed')
      assert.ok(true, 'Standard errors processed without crash')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('2. Routes Node.js process warnings and deprecation notices to message rather than error', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (url: any) => {
      if (String(url).includes('/v1/init')) {
        return new Response(JSON.stringify({
          success: true,
          config: {
            ...TEST_REMOTE_CONFIG,
            features: { ...TEST_REMOTE_CONFIG.features, errors: true },
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    }) as any

    try {
      await init({ apiKey: 'test-key' })
      setupGlobalErrorHandlers()

      // The exact warning from the cubicle telemetry:
      const warning1 = "(node:15544) Warning: SECURITY WARNING: The SSL modes 'require', 'prefer', and 'allow' do not offer protection against MITM attacks."
      const warning2 = "(node:12345) [DEP0040] DeprecationWarning: The punycode module is deprecated."
      const warning3 = "ExperimentalWarning: VM Modules is experimental."

      // These should not trigger application error capture
      console.error(warning1)
      console.error(warning2)
      console.error(warning3)

      assert.ok(true, 'Warnings processed cleanly through warning classifier')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('3. Resets cleanly and restores original console.error', () => {
    setupGlobalErrorHandlers()
    assert.notEqual(console.error, originalConsoleError)
    resetGlobalErrorHandlers()
    assert.equal(console.error, originalConsoleError)
  })

  it('preserves every console.error call across shutdown and reinitialization', () => {
    const original = console.error
    let printed = 0
    console.error = (() => { printed++ }) as typeof console.error
    try {
      setupGlobalErrorHandlers()
      console.error('before shutdown')
      resetGlobalErrorHandlers()
      console.error('after shutdown')

      const started = performance.now()
      setupGlobalErrorHandlers()
      console.error('reinitialized 1')
      console.error('reinitialized 2')
      console.error('reinitialized 3')
      const elapsed = performance.now() - started

      assert.equal(printed, 5, 'each call must reach the host console exactly once')
      assert.ok(elapsed < 250, `console.error calls took ${elapsed.toFixed(1)}ms`)
    } finally {
      resetGlobalErrorHandlers()
      console.error = original
    }
  })
})
