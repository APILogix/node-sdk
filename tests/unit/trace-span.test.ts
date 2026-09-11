import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { init, shutdown, startSpan, withSpan } from '../../src/index.js'
import { TEST_REMOTE_CONFIG } from '../fixtures/remote-config.js'

const originalFetch = globalThis.fetch

function setupMockFetch() {
  globalThis.fetch = (async (url: any) => {
    if (String(url).includes('/v1/init')) {
      return new Response(
        JSON.stringify({
          success: true,
          projectId: 'test-project',
          environment: 'test',
          release: '1.0.0',
          config: {
            ...TEST_REMOTE_CONFIG,
            features: {
              ...TEST_REMOTE_CONFIG.features,
              tracing: true,
              requestCapture: true,
            },
            sampling: {
              ...TEST_REMOTE_CONFIG.sampling,
              traces: 1,
              spans: 1,
              requests: 1,
            },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  }) as any
}

/**
 * Verifies that child spans inherit the same traceId as the root span.
 *
 * The SDK exposes individual named exports (no `Pulse` namespace), so we
 * import `init`, `shutdown`, and `startSpan` directly.
 */
describe('Pulse SDK Trace/Span Consistency', () => {
  beforeEach(() => {
    setupMockFetch()
  })

  afterEach(async () => {
    globalThis.fetch = originalFetch
    // Ensure SDK is shut down after each test to avoid side-effects.
    await shutdown()
  })

  it('withSpan installs an active parent so child spans share traceId', async () => {
    // Initialize the SDK against a non-routable host so init never tries
    // to reach a real backend; the offline-fallback config kicks in.
    await init({
      apiKey: 'test-key',
    })

    await withSpan('root', async rootSpan => {
      const rootTraceId = rootSpan.spanContext().traceId

      const childSpan = startSpan('child')
      const childTraceId = childSpan.spanContext().traceId

      assert.strictEqual(childTraceId, rootTraceId, 'Child span traceId differs from root')

      childSpan.end()
    })
  })

  it('plain startSpan does not activate context for following spans', async () => {
    await init({
      apiKey: 'test-key',
    })

    const rootSpan = startSpan('root')
    const childSpan = startSpan('child')

    assert.notStrictEqual(
      childSpan.spanContext().traceId,
      rootSpan.spanContext().traceId,
      'Plain startSpan should not make later spans automatic children',
    )

    childSpan.end()
    rootSpan.end()
  })

  it('monitorMiddleware extracts incoming W3C traceparent into server span and child spans', async () => {
    const { monitorMiddleware } = await import('../../src/instrumentation/express.js')
    const { trace } = await import('@opentelemetry/api')

    await init({
      apiKey: 'test-key',
    })

    const incomingTraceId = '4bf92f3577b34da6a3ce929d0e0e4736'
    const incomingParentSpanId = '00f067aa0ba902b7'
    const traceparent = `00-${incomingTraceId}-${incomingParentSpanId}-01`

    const req: any = {
      method: 'GET',
      url: '/test-route',
      path: '/test-route',
      headers: {
        traceparent,
      },
    }

    const listeners: Record<string, Function> = {}
    const res: any = {
      statusCode: 200,
      getHeader: () => undefined,
      once: (event: string, cb: Function) => {
        listeners[event] = cb
      },
      on: () => res,
      emit: () => true,
    }

    let capturedTraceId: string | undefined
    let childTraceId: string | undefined
    const middleware = monitorMiddleware()

    await new Promise<void>((resolve) => {
      middleware(req, res, () => {
        const activeSpan = trace.getActiveSpan()
        capturedTraceId = activeSpan?.spanContext().traceId

        const child = startSpan('db.query')
        childTraceId = child.spanContext().traceId
        child.end()

        resolve()
      })
    })

    assert.strictEqual(capturedTraceId, incomingTraceId, 'Server span should inherit incoming traceparent traceId')
    assert.strictEqual(childTraceId, incomingTraceId, 'Child span should inherit incoming traceparent traceId')

    if (listeners['finish']) listeners['finish']()
  })
})
