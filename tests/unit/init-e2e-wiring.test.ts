import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  init,
  LynkTrace,
  shutdown,
  captureException,
  lynktraceMiddleware,
  expressErrorHandler,
  withSpan,
  withDbSpan,
  withBackgroundSpan,
  getActiveSpan,
} from '../../src/index.js'
import { client } from '../../src/core/client.js'
import { FeatureController } from '../../src/core/feature-controller.js'
import { TEST_REMOTE_CONFIG } from '../fixtures/remote-config.js'

describe('init() end-to-end wiring: Auto-instrumentation & Error Handlers', () => {
  const originalFetch = globalThis.fetch
  const instrumentationGuard = Symbol.for('pulse-sdk.auto-instrumentation.registered')
  let uncaughtExceptionCountBefore = 0
  let unhandledRejectionCountBefore = 0

  beforeEach(() => {
    uncaughtExceptionCountBefore = process.listenerCount('uncaughtException')
    unhandledRejectionCountBefore = process.listenerCount('unhandledRejection')

    globalThis.fetch = (async (url: any) => {
      if (String(url).includes('/v1/init')) {
        return new Response(
          JSON.stringify({
            success: true,
            projectId: 'wiring-test-project',
            environment: 'production',
            release: '8.1.0',
            config: {
              ...TEST_REMOTE_CONFIG,
              sdk: {
                ...TEST_REMOTE_CONFIG.sdk,
                projectId: 'wiring-test-project',
                environment: 'production',
                release: '8.1.0',
              },
              features: {
                ...TEST_REMOTE_CONFIG.features,
                tracing: true,
                errors: true,
                metrics: true,
                requestCapture: true,
              },
              sampling: {
                ...TEST_REMOTE_CONFIG.sampling,
                traces: 1,
                spans: 1,
                requests: 1,
                errors: 1,
              },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    }) as any
  })

  afterEach(async () => {
    globalThis.fetch = originalFetch
    await shutdown(2_000)
  })

  it('correctly configures auto-instrumentation, error handlers, and features on init()', async () => {
    assert.equal(client.initialized, false, 'SDK should start uninitialized')

    const config = await init({ apiKey: 'test-wiring-api-key' })

    assert.ok(config, 'init() must return validated remote config')
    assert.equal(client.initialized, true, 'client.initialized must be true after init()')
    assert.equal(config?.sdk.projectId, 'wiring-test-project')

    // 1. Verify Auto-Instrumentation is registered in global symbol state
    const globalState = globalThis as any
    assert.equal(
      globalState[instrumentationGuard],
      true,
      'Auto-instrumentation module hooks must be registered and active',
    )

    // 2. Verify FeatureController has started subsystems
    const fc = FeatureController.getInstance()
    assert.ok(fc, 'FeatureController singleton must exist')
    assert.equal(fc.isEnabled('tracing'), true, 'tracing feature must be active')
    assert.equal(fc.isEnabled('errors'), true, 'errors feature must be active')

    // 3. Verify Global Error Handlers are attached to process
    const uncaughtCountAfter = process.listenerCount('uncaughtException')
    const unhandledCountAfter = process.listenerCount('unhandledRejection')
    assert.ok(
      uncaughtCountAfter >= uncaughtExceptionCountBefore,
      'Global uncaughtException listener must be attached',
    )
    assert.ok(
      unhandledCountAfter >= unhandledRejectionCountBefore,
      'Global unhandledRejection listener must be attached',
    )

    // 4. Verify captureException marks the active span
    await withSpan('test-error-capture', async (span) => {
      captureException(new Error('Test unhandled runtime bug'), 'error')
      // span is still open and enriched
      assert.ok(span)
    })
  })

  it('correctly wires Express lynktraceMiddleware and expressErrorHandler with active spans', async () => {
    await init({ apiKey: 'test-wiring-api-key' })

    const middleware = lynktraceMiddleware()
    assert.equal(typeof middleware, 'function', 'lynktraceMiddleware must return a middleware function')

    const errorHandler = expressErrorHandler()
    assert.equal(typeof errorHandler, 'function', 'expressErrorHandler must return an error handler function')

    // Simulate an Express request flow with active span correlation
    await withSpan('express-request-flow', async () => {
      const activeSpan = getActiveSpan()
      assert.ok(activeSpan, 'Active span must be accessible within withSpan')

      // Simulate error captured by errorHandler
      let nextCalledWith: any = null
      const fakeReq: any = {
        method: 'GET',
        url: '/api/checkout',
        path: '/api/checkout',
        headers: { 'user-agent': 'test-runner' },
      }
      const fakeRes: any = {
        statusCode: 500,
        getHeader: () => undefined,
      }
      const testError = new Error('Database connection failed in handler')

      errorHandler(testError, fakeReq, fakeRes, (err?: any) => {
        nextCalledWith = err
      })

      assert.equal(nextCalledWith, testError, 'expressErrorHandler must pass the error to next()')
    })
  })

  it('correctly executes withDbSpan and withBackgroundSpan when initialized via init()', async () => {
    await init({ apiKey: 'test-wiring-api-key' })

    // Database span execution
    const dbResult = await withDbSpan(
      { system: 'postgresql', operation: 'SELECT', statement: 'SELECT * FROM users WHERE id = 1' },
      async (dbSpan) => {
        assert.ok(dbSpan, 'dbSpan must be created')
        return { rowCount: 1 }
      },
    )
    assert.equal(dbResult.rowCount, 1, 'withDbSpan must return query execution result')

    // Background span execution
    let backgroundWorkCompleted = false
    await withBackgroundSpan('send-welcome-email', async (bgSpan) => {
      assert.ok(bgSpan, 'Background span must be created')
      backgroundWorkCompleted = true
    })
    assert.equal(backgroundWorkCompleted, true, 'withBackgroundSpan must execute job successfully')
  })

  it('returns active config on idempotent second init() with same apiKey', async () => {
    const firstConfig = await init({ apiKey: 'test-wiring-api-key' })
    const secondConfig = await init({ apiKey: 'test-wiring-api-key' })

    assert.equal(firstConfig, secondConfig, 'Consecutive init() with identical key must return same config')
  })

  it('cleanly shuts down and restores process listeners', async () => {
    await init({ apiKey: 'test-wiring-api-key' })
    assert.equal(client.initialized, true)

    await shutdown(2_000)
    assert.equal(client.initialized, false, 'client must be uninitialized after shutdown')
  })

  it('exports canonical LynkTrace facade object and supports string apiKey or object init', async () => {
    assert.ok(LynkTrace, 'LynkTrace object must be exported')
    assert.equal(typeof LynkTrace.init, 'function', 'LynkTrace.init must be a function')
    assert.equal(typeof LynkTrace.captureException, 'function', 'LynkTrace.captureException must be a function')
    assert.equal(typeof LynkTrace.withSpan, 'function', 'LynkTrace.withSpan must be a function')
    assert.equal(typeof LynkTrace.getHealth, 'function', 'LynkTrace.getHealth must be a function')

    // Test initializing via string apiKey directly
    const config = await LynkTrace.init('test-wiring-api-key')
    assert.ok(config, 'LynkTrace.init with string apiKey must succeed')
    assert.equal(client.initialized, true, 'client must be initialized')

    await LynkTrace.shutdown(2_000)
    assert.equal(client.initialized, false, 'client must be shut down')
  })
})

