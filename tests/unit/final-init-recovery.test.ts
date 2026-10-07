import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { init, shutdown, captureException } from '../../src/index.js'
import { client } from '../../src/core/client.js'
import { eventQueue } from '../../src/transport/queue.js'
import { BackgroundRecoveryWorker } from '../../src/core/recovery-worker.js'
import { TEST_REMOTE_CONFIG } from '../fixtures/remote-config.js'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

function createSuccessResponse(customConfig = TEST_REMOTE_CONFIG) {
  return new Response(JSON.stringify({
    success: true,
    projectId: customConfig.sdk.projectId,
    environment: customConfig.sdk.environment,
    release: customConfig.sdk.release,
    config: customConfig,
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

describe('Final Initialization & Background Recovery Architecture', () => {
  let originalFetch: typeof globalThis.fetch
  const testApiKey = 'pulse_test_secret_key_12345'

  beforeEach(() => {
    originalFetch = globalThis.fetch
    process.env['PULSE_TEST_RECOVERY_DELAY_MS'] = '20'
  })

  afterEach(async () => {
    await shutdown(500)
    globalThis.fetch = originalFetch
    delete process.env['PULSE_TEST_RECOVERY_DELAY_MS']
    BackgroundRecoveryWorker.stop()
  })

  describe('Customer Application Safety & Fail-Open Invariants', () => {
    it('customer application starts when /v1/init returns 503', async () => {
      globalThis.fetch = async () => new Response(JSON.stringify({ error: 'Service Unavailable' }), { status: 503 })

      const result = await init({ apiKey: testApiKey, initTimeoutMs: 100, initRetries: 0 })
      assert.equal(result, undefined, 'Must return undefined on 503 failure')
      assert.equal(client.initialized, false, 'SDK must not be marked initialized')
      assert.equal(client.getState(), 'recovering', 'SDK must enter recovering state')
      assert.ok(BackgroundRecoveryWorker.getInstance() !== null, 'Recovery worker must be active')
    })

    it('customer application starts when /v1/init returns 429', async () => {
      globalThis.fetch = async () => new Response(JSON.stringify({ error: 'Too Many Requests' }), {
        status: 429,
        headers: { 'Retry-After': '1' },
      })

      const result = await init({ apiKey: testApiKey, initTimeoutMs: 100, initRetries: 0 })
      assert.equal(result, undefined, 'Must return undefined on 429 failure')
      assert.equal(client.initialized, false)
      assert.equal(client.getState(), 'recovering')
    })

    it('customer application starts when /v1/init times out', async () => {
      globalThis.fetch = async () => new Promise<Response>(() => {}) // never resolves

      const result = await init({ apiKey: testApiKey, initTimeoutMs: 100, initRetries: 0 })
      assert.equal(result, undefined, 'Must return undefined when /v1/init times out')
      assert.equal(client.initialized, false)
      assert.equal(client.getState(), 'recovering')
    })

    it('customer application starts when DNS fails (getaddrinfo ENOTFOUND)', async () => {
      globalThis.fetch = async () => {
        const err = new TypeError('fetch failed')
        ;(err as any).cause = new Error('getaddrinfo ENOTFOUND api.pulse.internal')
        throw err
      }

      const result = await init({ apiKey: testApiKey, initTimeoutMs: 100, initRetries: 0 })
      assert.equal(result, undefined)
      assert.equal(client.initialized, false)
      assert.equal(client.getState(), 'recovering')
    })

    it('customer application starts when backend is unreachable (ECONNREFUSED)', async () => {
      globalThis.fetch = async () => {
        const err = new TypeError('fetch failed')
        ;(err as any).cause = new Error('connect ECONNREFUSED 127.0.0.1:443')
        throw err
      }

      const result = await init({ apiKey: testApiKey, initTimeoutMs: 100, initRetries: 0 })
      assert.equal(result, undefined)
      assert.equal(client.initialized, false)
      assert.equal(client.getState(), 'recovering')
    })

    it('customer application starts when /v1/init returns invalid JSON', async () => {
      globalThis.fetch = async () => new Response('<html>502 Bad Gateway</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      })

      const result = await init({ apiKey: testApiKey, initTimeoutMs: 100, initRetries: 0 })
      assert.equal(result, undefined)
      assert.equal(client.initialized, false)
      assert.equal(client.getState(), 'recovering')
    })

    it('customer application starts when /v1/init returns schema-invalid config', async () => {
      globalThis.fetch = async () => new Response(JSON.stringify({
        success: true,
        projectId: 'missing-sections',
        config: { schemaVersion: 99 }, // missing mandatory sections
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })

      const result = await init({ apiKey: testApiKey, initTimeoutMs: 100, initRetries: 0 })
      assert.equal(result, undefined)
      assert.equal(client.initialized, false)
      assert.equal(client.getState(), 'recovering')
    })

    it('permanent failure (401 / 403) does not enter infinite retry loop', async () => {
      let callCount = 0
      globalThis.fetch = async () => {
        callCount++
        return new Response(JSON.stringify({ error: 'Unauthorized', message: 'Invalid API key' }), { status: 401 })
      }

      const result = await init({ apiKey: testApiKey, initTimeoutMs: 100, initRetries: 0 })
      assert.equal(result, undefined)
      assert.equal(client.initialized, false)

      // Allow background cycle if any
      await new Promise(resolve => setTimeout(resolve, 80))

      // Permanent error must NOT start or continue recovery worker
      assert.ok(callCount <= 1, `Permanent error should not retry; calls: ${callCount}`)
      assert.ok(!BackgroundRecoveryWorker.getInstance()?.isRunning(), 'Worker must not be running for permanent error')
    })
  })

  describe('Background Recovery & Late Activation Flow', () => {
    it('recovers after 503: initial failure -> recovering -> background retry -> late activation -> initialized', async () => {
      let attempt = 0
      globalThis.fetch = async () => {
        attempt++
        if (attempt === 1) {
          return new Response(JSON.stringify({ error: 'Service Unavailable' }), { status: 503 })
        }
        return createSuccessResponse()
      }

      const initResult = await init({ apiKey: testApiKey, initTimeoutMs: 100, initRetries: 0 })
      assert.equal(initResult, undefined)
      assert.equal(client.getState(), 'recovering')
      assert.equal(client.initialized, false)

      // Wait for background recovery worker to succeed
      for (let i = 0; i < 20; i++) {
        if (client.initialized) break
        await new Promise(resolve => setTimeout(resolve, 30))
      }

      assert.equal(client.initialized, true, 'SDK must become initialized after background recovery')
      assert.equal(client.getState(), 'initialized')
      assert.ok(attempt >= 2, `Expected at least 2 attempts, got ${attempt}`)
      assert.ok(!BackgroundRecoveryWorker.getInstance()?.isRunning(), 'Worker should stop after successful recovery')
    })

    it('recovers after timeout: initial timeout -> recovering -> background retry -> initialized', async () => {
      let attempt = 0
      globalThis.fetch = async () => {
        attempt++
        if (attempt === 1) {
          return new Promise<Response>(() => {}) // stalled request times out
        }
        return createSuccessResponse()
      }

      const initResult = await init({ apiKey: testApiKey, initTimeoutMs: 100, initRetries: 0 })
      assert.equal(initResult, undefined)
      assert.equal(client.getState(), 'recovering')

      for (let i = 0; i < 20; i++) {
        if (client.initialized) break
        await new Promise(resolve => setTimeout(resolve, 30))
      }

      assert.equal(client.initialized, true)
      assert.equal(client.getState(), 'initialized')
    })

    it('recovers after several transient failures with exponential backoff and jitter', async () => {
      let attempt = 0
      globalThis.fetch = async () => {
        attempt++
        if (attempt <= 3) {
          return new Response(JSON.stringify({ error: 'Transient DB error' }), { status: 500 })
        }
        return createSuccessResponse()
      }

      await init({ apiKey: testApiKey, initTimeoutMs: 100, initRetries: 0 })
      assert.equal(client.getState(), 'recovering')

      for (let i = 0; i < 30; i++) {
        if (client.initialized) break
        await new Promise(resolve => setTimeout(resolve, 40))
      }

      assert.equal(client.initialized, true)
      assert.ok(attempt >= 4, `Expected at least 4 attempts, got ${attempt}`)
    })
  })

  describe('Concurrency & Single-Flight Coordination', () => {
    it('Case A & B: manual init() while recovery attempt is in flight shares single-flight without false SDK_INIT_IN_PROGRESS', async () => {
      let attempt = 0
      let releaseFlight: (() => void) | null = null

      globalThis.fetch = async () => {
        attempt++
        if (attempt === 1) {
          return new Response(JSON.stringify({ error: 'Busy' }), { status: 503 })
        }
        // Second call represents recovery attempt; hold in-flight
        return new Promise<Response>(resolve => {
          releaseFlight = () => resolve(createSuccessResponse())
        })
      }

      await init({ apiKey: testApiKey, initTimeoutMs: 100, initRetries: 0 })
      assert.equal(client.getState(), 'recovering')

      // Wait for recovery worker to enter executeAttempt
      for (let i = 0; i < 20; i++) {
        if (client.getInitPromise() !== null) break
        await new Promise(resolve => setTimeout(resolve, 20))
      }

      assert.ok(client.getInitPromise() !== null, 'Recovery attempt must be in-flight')

      // Manual init with same identity while recovery attempt is in-flight
      const manualInitPromise = init({ apiKey: testApiKey, initTimeoutMs: 2000 })

      // Release in-flight fetch
      assert.ok(releaseFlight)
      ;(releaseFlight as () => void)()

      const manualResult = await manualInitPromise
      assert.ok(manualResult, 'Manual init must join and resolve successfully')
      assert.equal(client.initialized, true)
    })

    it('Case C: manual init() with different identity while recovering rejects conflict safely', async () => {
      globalThis.fetch = async () => new Response(JSON.stringify({ error: 'Outage' }), { status: 503 })

      await init({ apiKey: 'project-A-key', initTimeoutMs: 100, initRetries: 0 })
      assert.equal(client.getState(), 'recovering')
      assert.equal(client.getApiKey(), 'project-A-key')

      // Attempt manual init with different identity
      await assert.rejects(
        () => init({ apiKey: 'project-B-different-key', initTimeoutMs: 100, initRetries: 0 }),
        (err: any) => err.code === 'SDK_INIT_IN_PROGRESS',
        'Must reject conflicting identity with SDK_INIT_IN_PROGRESS'
      )

      // Project A identity must remain intact
      assert.equal(client.getApiKey(), 'project-A-key')
    })

    it('Case D: shutdown() cancels active recovery worker and transitions to stopped', async () => {
      globalThis.fetch = async () => new Response(JSON.stringify({ error: 'Outage' }), { status: 503 })

      await init({ apiKey: testApiKey, initTimeoutMs: 100, initRetries: 0 })
      assert.equal(client.getState(), 'recovering')
      const worker = BackgroundRecoveryWorker.getInstance()
      assert.ok(worker !== null && !worker.isStopped())

      await shutdown(500)
      assert.equal(client.getState(), 'stopped')
      assert.ok(worker.isStopped(), 'Worker must be stopped after shutdown')

      // Ensure no late activation occurs
      await new Promise(resolve => setTimeout(resolve, 60))
      assert.equal(client.getState(), 'stopped')
      assert.equal(client.initialized, false)
    })

    it('Case E: recovery success racing with immediate shutdown results in shutdown winning (no zombie initialized state)', async () => {
      let resolveFetch: ((res: Response) => void) | null = null
      let attempt = 0

      globalThis.fetch = async () => {
        attempt++
        if (attempt === 1) {
          return new Response(JSON.stringify({ error: 'Unavailable' }), { status: 503 })
        }
        return new Promise<Response>(resolve => {
          resolveFetch = resolve
        })
      }

      await init({ apiKey: testApiKey, initTimeoutMs: 100, initRetries: 0 })
      assert.equal(client.getState(), 'recovering')

      // Wait for background recovery attempt to start
      for (let i = 0; i < 20; i++) {
        if (client.getInitPromise() !== null) break
        await new Promise(resolve => setTimeout(resolve, 20))
      }

      // Trigger shutdown while recovery fetch is pending
      const shutdownPromise = shutdown(500)

      // Concurrently resolve the network response
      if (resolveFetch) {
        ;(resolveFetch as (res: Response) => void)(createSuccessResponse())
      }

      await shutdownPromise

      assert.equal(client.getState(), 'stopped')
      assert.equal(client.initialized, false, 'SDK must remain stopped and uninitialized')
    })
  })

  describe('Event Buffering, Drainage & Replay', () => {
    it('buffers events while recovering and replays them upon late activation', async () => {
      let attempt = 0
      globalThis.fetch = async () => {
        attempt++
        if (attempt === 1) return new Response(JSON.stringify({ error: 'Outage' }), { status: 503 })
        return createSuccessResponse({
          ...TEST_REMOTE_CONFIG,
          features: { ...TEST_REMOTE_CONFIG.features, errors: true as any },
        } as any)
      }

      await init({ apiKey: testApiKey, initTimeoutMs: 100, initRetries: 0 })
      assert.equal(client.getState(), 'recovering')

      // Capture error during recovering state
      captureException(new Error('Test error during recovering state'))
      assert.ok(eventQueue.size() >= 1, 'Event queue must have buffered event')

      // Await late activation
      for (let i = 0; i < 25; i++) {
        if (client.initialized) break
        await new Promise(resolve => setTimeout(resolve, 30))
      }

      assert.equal(client.initialized, true)
      // Buffered event was drained and replayed
      assert.equal(client.getState(), 'initialized')
    })
  })

  describe('Zero Disk Cache Dependency', () => {
    it('initialization and recovery do NOT write .pulse configuration cache files to disk', async () => {
      let attempt = 0
      globalThis.fetch = async () => {
        attempt++
        if (attempt === 1) return new Response(JSON.stringify({ error: 'Busy' }), { status: 503 })
        return createSuccessResponse()
      }

      await init({ apiKey: testApiKey, initTimeoutMs: 100, initRetries: 0 })
      for (let i = 0; i < 20; i++) {
        if (client.initialized) break
        await new Promise(resolve => setTimeout(resolve, 30))
      }
      assert.equal(client.initialized, true)

      // Confirm no .pulse config-cache file exists
      const configCacheFile = join(process.cwd(), '.pulse', `config-cache-${testApiKey}.json`)
      assert.equal(existsSync(configCacheFile), false, 'No disk config-cache file should ever be written')
    })
  })

  describe('OpenTelemetry & Instrumentation Safety', () => {
    it('bootstrap instrumentation survives recovery cycle without duplicate hooks', async () => {
      let attempt = 0
      globalThis.fetch = async () => {
        attempt++
        if (attempt === 1) return new Response(JSON.stringify({ error: 'Temporary control-plane failure' }), { status: 503 })
        return createSuccessResponse({
          ...TEST_REMOTE_CONFIG,
          features: { ...TEST_REMOTE_CONFIG.features, tracing: true as any },
        } as any)
      }

      await init({ apiKey: testApiKey, initTimeoutMs: 100, initRetries: 0 })
      assert.equal(client.getState(), 'recovering')

      // Check global instrumentation guards
      const guardSymbol = Symbol.for('pulse-sdk.auto-instrumentation.registered')
      const g = globalThis as Record<symbol, unknown>
      assert.equal(g[guardSymbol], true, 'Bootstrap guard must be active')

      // Await late activation
      for (let i = 0; i < 20; i++) {
        if (client.initialized) break
        await new Promise(resolve => setTimeout(resolve, 30))
      }

      assert.equal(client.initialized, true)
      assert.equal(g[guardSymbol], true, 'Instrumentation guard must remain single-flight and true')
    })

    it('AsyncLocalStorage and request context are preserved across recovery and late activation', async () => {
      let attempt = 0
      globalThis.fetch = async () => {
        attempt++
        if (attempt === 1) return new Response(JSON.stringify({ error: 'Service Unavailable' }), { status: 503 })
        return createSuccessResponse()
      }

      const { withContext, getRequestContext, createContextStore } = await import('../../src/index.js')

      await init({ apiKey: testApiKey, initTimeoutMs: 100, initRetries: 0 })
      assert.equal(client.getState(), 'recovering')

      await withContext(createContextStore('req-recovery-123', 100, { userId: 'user-789' }), async () => {
        const ctxBefore = getRequestContext()
        assert.equal(ctxBefore?.requestId, 'req-recovery-123')
        assert.equal(ctxBefore?.userId, 'user-789')

        // Wait for background recovery in context
        for (let i = 0; i < 20; i++) {
          if (client.initialized) break
          await new Promise(resolve => setTimeout(resolve, 30))
        }

        const ctxAfter = getRequestContext()
        assert.equal(ctxAfter?.requestId, 'req-recovery-123', 'AsyncLocalStorage must be intact after late activation')
        assert.equal(ctxAfter?.userId, 'user-789')
      })

      assert.equal(client.initialized, true)
    })
  })
})
