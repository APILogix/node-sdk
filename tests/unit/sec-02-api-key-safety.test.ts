import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { init, Pulse, shutdown } from '../../src/index.js'
import { client } from '../../src/core/client.js'
import { BackgroundRecoveryWorker } from '../../src/core/recovery-worker.js'
import { TransportRouter } from '../../src/transport/transport-router.js'
import { TEST_REMOTE_CONFIG } from '../fixtures/remote-config.js'

describe('SEC-02: Missing or Invalid API Key Never Crashes Host Application', () => {
  const originalFetch = globalThis.fetch
  const instrumentationGuard = Symbol.for('pulse-sdk.auto-instrumentation.registered')
  const bootstrapGuard = Symbol.for('pulse-sdk.auto-instrumentation.bootstrap')
  const VALID_TEST_KEY = 'pulse_live_test_key_valid_12345'

  function mockSuccessFetch(customConfig = TEST_REMOTE_CONFIG) {
    globalThis.fetch = (async (url: any) => {
      if (String(url).includes('/v1/init')) {
        return new Response(
          JSON.stringify({
            success: true,
            projectId: customConfig.sdk.projectId,
            environment: customConfig.sdk.environment,
            release: customConfig.sdk.release,
            config: customConfig,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    }) as any
  }

  beforeEach(() => {
    mockSuccessFetch()
  })

  afterEach(async () => {
    globalThis.fetch = originalFetch
    await shutdown(1000)
    BackgroundRecoveryWorker.stop()
  })

  // ─── Test 1: Missing API key ──────────────────────────────────────────────
  describe('Test 1 — Missing API key', () => {
    it('init({}) does not throw and safely resolves to undefined', async () => {
      // Must not throw or reject
      let returnedValue: unknown = 'sentinel'
      await assert.doesNotReject(async () => {
        returnedValue = await init({})
      }, 'init({}) must not reject or throw into the host application')

      assert.equal(returnedValue, undefined, 'init({}) must return undefined')
      assert.equal(client.initialized, false, 'SDK must not be initialized')
      assert.equal(client.getState(), 'disabled', 'SDK must enter disabled state')
    })

    it('init() without arguments does not throw and safely resolves to undefined', async () => {
      let returnedValue: unknown = 'sentinel'
      await assert.doesNotReject(async () => {
        returnedValue = await (init as any)()
      }, 'init() without arguments must not reject or throw')

      assert.equal(returnedValue, undefined)
      assert.equal(client.initialized, false)
      assert.equal(client.getState(), 'disabled')
    })
  })

  // ─── Test 2: Invalid API key ──────────────────────────────────────────────
  describe('Test 2 — Invalid API key', () => {
    const invalidKeyInputs: Array<{ name: string; options: any }> = [
      { name: 'empty string', options: { apiKey: '' } },
      { name: 'whitespace only', options: { apiKey: '   ' } },
      { name: 'null apiKey', options: { apiKey: null } },
      { name: 'number apiKey', options: { apiKey: 12345 } },
      { name: 'boolean apiKey', options: { apiKey: true } },
      { name: 'control character null byte', options: { apiKey: 'invalid\x00key' } },
      { name: 'control characters CRLF', options: { apiKey: 'key\r\ninjection' } },
      { name: 'control character BEL', options: { apiKey: 'key\x07bell' } },
    ]

    for (const { name, options } of invalidKeyInputs) {
      it(`does not crash or throw for ${name}`, async () => {
        let result: unknown = 'sentinel'
        await assert.doesNotReject(async () => {
          result = await init(options)
        }, `init(${JSON.stringify(options)}) must not reject`)

        assert.equal(result, undefined, 'Must return undefined for invalid configuration')
        assert.equal(client.initialized, false, 'SDK must remain uninitialized')
        assert.equal(client.getState(), 'disabled', 'SDK must enter disabled state')
        assert.equal(
          BackgroundRecoveryWorker.getInstance()?.isRunning() ?? false,
          false,
          'Background recovery worker must not run for invalid API key',
        )
      })
    }
  })

  // ─── Test 3: Valid API key regression ─────────────────────────────────────
  describe('Test 3 — Valid API key regression', () => {
    it('init({ apiKey: VALID_TEST_KEY }) initializes successfully as before', async () => {
      const config = await init({ apiKey: VALID_TEST_KEY })

      assert.ok(config, 'init() must return validated remote config for valid API key')
      assert.equal(client.initialized, true, 'client.initialized must be true')
      assert.equal(client.getState(), 'initialized', 'client state must be initialized')
      assert.equal(config?.sdk.projectId, TEST_REMOTE_CONFIG.sdk.projectId)
    })
  })

  // ─── Test 4: No partial initialization ────────────────────────────────────
  describe('Test 4 — No partial initialization', () => {
    it('leaves behind zero workers, timers, or registered auto-instrumentations', async () => {
      // Record initial listener counts
      const sigtermListenersBefore = process.listenerCount('SIGTERM')
      const sigintListenersBefore = process.listenerCount('SIGINT')
      const uncaughtListenersBefore = process.listenerCount('uncaughtException')
      const unhandledListenersBefore = process.listenerCount('unhandledRejection')

      await init({})

      // 1. Recovery worker must not be running
      assert.equal(
        BackgroundRecoveryWorker.getInstance()?.isRunning() ?? false,
        false,
        'No recovery worker should be running',
      )

      // 2. Transport router must not be initialized or active
      const transport = TransportRouter.getInstance()
      assert.ok(!transport || transport.isDisabled(), 'TransportRouter must be null or disabled')

      // 3. Auto-instrumentation guard symbols must not remain active
      const g = globalThis as any
      assert.equal(
        Boolean(g[instrumentationGuard]),
        false,
        'Auto-instrumentation registered guard must not be set',
      )
      assert.equal(
        Boolean(g[bootstrapGuard]),
        false,
        'Bootstrap instrumentation guard must not be set',
      )

      // 4. No new process-level listeners registered
      assert.equal(process.listenerCount('SIGTERM'), sigtermListenersBefore, 'Must not leak SIGTERM listeners')
      assert.equal(process.listenerCount('SIGINT'), sigintListenersBefore, 'Must not leak SIGINT listeners')
      assert.equal(
        process.listenerCount('uncaughtException'),
        uncaughtListenersBefore,
        'Must not leak uncaughtException listeners',
      )
      assert.equal(
        process.listenerCount('unhandledRejection'),
        unhandledListenersBefore,
        'Must not leak unhandledRejection listeners',
      )
    })
  })

  // ─── Test 5: Host application survival ────────────────────────────────────
  describe('Test 5 — Host application survival', () => {
    it('host application continues working normally after unconfigured init()', async () => {
      // Simulate realistic customer code
      await Pulse.init({})

      // Host application performs its normal business logic
      async function hostApplicationService(a: number, b: number): Promise<number> {
        return a * b + 42
      }

      const result = await hostApplicationService(10, 5)
      assert.equal(result, 92, 'Host business logic executes normally')

      // SDK capture APIs fail-open safely without throwing
      assert.doesNotThrow(() => {
        Pulse.captureError(new Error('simulated customer error during disabled state'))
      })

      assert.doesNotThrow(() => {
        Pulse.captureMessage('test message')
      })

      // Function decorators fail-open safely
      const wrapped = Pulse.wrap('custom.func', (x: number) => x * 2)
      assert.equal(wrapped(21), 42, 'Pulse.wrap must pass through when SDK is disabled')

      const traceResult = await Pulse.trace('custom.async', async () => 'app_value')
      assert.equal(traceResult, 'app_value', 'Pulse.trace must pass through when SDK is disabled')
    })
  })

  // ─── Test 6: No uncaught exception ────────────────────────────────────────
  describe('Test 6 — No uncaught exception or unhandled rejection', () => {
    it('does not trigger process uncaughtException or unhandledRejection', async () => {
      const uncaughtErrors: Error[] = []
      const unhandledRejections: unknown[] = []

      const uncaughtHandler = (err: Error) => { uncaughtErrors.push(err) }
      const rejectionHandler = (reason: unknown) => { unhandledRejections.push(reason) }

      process.on('uncaughtException', uncaughtHandler)
      process.on('unhandledRejection', rejectionHandler)

      try {
        await Pulse.init({})
        await Pulse.init({ apiKey: '' })
        await Pulse.init({ apiKey: 'invalid\x00key' })

        // Give the event loop a few turns to catch any asynchronous escapes
        await new Promise(resolve => setImmediate(resolve))
        await new Promise(resolve => setTimeout(resolve, 50))

        assert.equal(uncaughtErrors.length, 0, 'Zero uncaughtException events must be emitted')
        assert.equal(unhandledRejections.length, 0, 'Zero unhandledRejection events must be emitted')
      } finally {
        process.removeListener('uncaughtException', uncaughtHandler)
        process.removeListener('unhandledRejection', rejectionHandler)
      }
    })
  })

  // ─── Test 7: Repeated initialization ──────────────────────────────────────
  describe('Test 7 — Repeated initialization', () => {
    it('handles multiple consecutive invalid init() calls and recovers on subsequent valid init()', async () => {
      // 1. Call init({}) repeatedly
      await assert.doesNotReject(async () => {
        await init({})
        await init({})
        await init({})
      }, 'Consecutive invalid init() calls must not throw')

      assert.equal(client.initialized, false, 'SDK must remain uninitialized')
      assert.equal(client.getState(), 'disabled', 'SDK state must remain disabled')

      // 2. Subsequent call with valid key initializes cleanly
      const config = await init({ apiKey: VALID_TEST_KEY })
      assert.ok(config, 'Subsequent init() with valid key must succeed')
      assert.equal(client.initialized, true, 'SDK must become initialized')
      assert.equal(client.getState(), 'initialized', 'SDK state must become initialized')
    })
  })

  // ─── Test 8: Security requirement — no sensitive data in diagnostic ───────
  describe('Test 8 — Security requirement: no secrets exposed in diagnostics', () => {
    it('does not leak candidate API key in stderr or log messages', async () => {
      const interceptedOutput: string[] = []
      const originalStderrWrite = process.stderr.write

      const sensitiveCandidateKey = 'super_secret_token_12345_should_never_be_logged'

      process.stderr.write = ((chunk: any, ...args: any[]) => {
        interceptedOutput.push(String(chunk))
        return (originalStderrWrite as any).call(process.stderr, chunk, ...args)
      }) as any

      try {
        await init({ apiKey: sensitiveCandidateKey + '\x00illegal' })
      } finally {
        process.stderr.write = originalStderrWrite
      }

      const allOutput = interceptedOutput.join('\n')
      assert.ok(
        !allOutput.includes(sensitiveCandidateKey),
        'Candidate API key value must NEVER be logged to stderr',
      )
      assert.ok(
        allOutput.includes('SDK disabled: missing or invalid API key'),
        'Diagnostic message must indicate SDK is disabled',
      )
    })
  })
})
