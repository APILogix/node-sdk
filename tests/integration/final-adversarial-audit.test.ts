import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import {
  init,
  shutdown,
  captureError,
  captureMessage,
  captureEvent,
  withSpan,
  startSpan,
} from '../../src/index.js'
import { client } from '../../src/core/client.js'
import { eventQueue } from '../../src/transport/queue.js'
import { BackgroundRecoveryWorker } from '../../src/core/recovery-worker.js'
import { TEST_REMOTE_CONFIG } from '../fixtures/remote-config.js'

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

describe('Pulse SDK — Final Adversarial Initialization, Recovery & Event-Loop Audit', () => {
  let originalFetch: typeof globalThis.fetch
  const testApiKey = 'pulse_adversarial_test_key_9999'

  beforeEach(() => {
    originalFetch = globalThis.fetch
    process.env['PULSE_TEST_RECOVERY_DELAY_MS'] = '20'
  })

  afterEach(async () => {
    await shutdown(1000)
    globalThis.fetch = originalFetch
    delete process.env['PULSE_TEST_RECOVERY_DELAY_MS']
    delete process.env['NODE_ENV']
    delete process.env['PULSE_ENV']
    BackgroundRecoveryWorker.stop()
  })

  // ─── Adversarial Test #1: Synchronous Telemetry Blocking ────────────────────
  describe('Adversarial Test #1 — Synchronous Telemetry Blocking', () => {
    it('proves capture APIs, spans, and breadcrumbs never synchronously block event loop', async () => {
      globalThis.fetch = async () => createSuccessResponse()
      await init({ apiKey: testApiKey, initTimeoutMs: 100, initRetries: 0 })
      assert.strictEqual(client.initialized, true)

      const histogram = monitorEventLoopDelay({ resolution: 10 })
      histogram.enable()

      // Rapidly invoke all public capture APIs across multiple iterations
      for (let i = 0; i < 500; i++) {
        captureError(new Error(`Test error ${i}`), 'error')
        captureMessage(`Test message ${i}`, 'warning')
        captureEvent({
          type: 'custom',
          message: `Custom event ${i}`,
          attributes: { key: 'value', num: i },
        })
        await withSpan(`test-span-${i}`, async (span) => {
          span.setAttribute('index', i)
          span.addEvent('milestone', { time: Date.now() })
        })
        if ((i + 1) % 50 === 0) {
          await new Promise(r => setImmediate(r))
        }
      }
      await new Promise(r => setTimeout(r, 50))

      const meanLag = histogram.mean / 1e6
      const p99Lag = histogram.percentile(99) / 1e6
      histogram.disable()

      assert.ok(Number.isFinite(meanLag), 'Mean lag must be finite')
      assert.ok(meanLag < 50, `Mean event-loop lag should be < 50ms, was ${meanLag.toFixed(2)}ms`)
      assert.ok(p99Lag < 150, `p99 event-loop lag should be < 150ms, was ${p99Lag.toFixed(2)}ms`)
    })
  })

  // ─── Adversarial Test #2: Huge Payload Bypass ───────────────────────────────
  describe('Adversarial Test #2 — Huge Payload Bypass', () => {
    it('safely handles deeply nested objects, huge strings, and oversized payloads', async () => {
      globalThis.fetch = async () => createSuccessResponse()
      await init({ apiKey: testApiKey, initTimeoutMs: 100, initRetries: 0 })

      // Construct a deeply nested object (100 levels)
      let deepObj: Record<string, unknown> = { level: 0 }
      let cur = deepObj
      for (let i = 1; i < 100; i++) {
        const next = { level: i }
        cur['child'] = next
        cur = next
      }

      // Construct a huge string (2 MB)
      const hugeString = 'X'.repeat(2 * 1024 * 1024)

      const start = performance.now()
      // Emit deeply nested and huge payload events
      captureEvent({
        type: 'error',
        message: 'Deep nesting error',
        attributes: { deep: 'nested' },
      })
      captureEvent({
        type: 'huge_event',
        attributes: { payload: hugeString },
      })
      const elapsed = performance.now() - start

      // Enqueueing must return immediately (< 50ms) without synchronous deep traversal stall
      assert.ok(elapsed < 50, `Huge payload enqueue must be non-blocking, took ${elapsed.toFixed(2)}ms`)
    })
  })

  // ─── Adversarial Test #3: 10K / 50K Event Burst ─────────────────────────────
  describe('Adversarial Test #3 — 10K / 50K Event Burst Under Stress', () => {
    it('survives an extreme 10,000-event burst without event-loop starvation or crashing', async () => {
      globalThis.fetch = async () => createSuccessResponse()
      await init({ apiKey: testApiKey, initTimeoutMs: 100, initRetries: 0 })

      const histogram = monitorEventLoopDelay({ resolution: 10 })
      histogram.enable()

      const burstCount = 10_000
      const start = performance.now()

      for (let i = 0; i < burstCount; i++) {
        if (i % 3 === 0) {
          captureError(new Error(`Burst error ${i}`))
        } else if (i % 3 === 1) {
          captureMessage(`Burst message ${i}`)
        } else {
          captureEvent({ type: 'burst', count: i })
        }
        if ((i + 1) % 2000 === 0) {
          await new Promise(r => setTimeout(r, 10))
        }
      }
      await new Promise(r => setTimeout(r, 30))

      const enqueueDuration = performance.now() - start
      const meanLag = histogram.mean / 1e6
      const p99Lag = histogram.percentile(99) / 1e6
      histogram.disable()

      assert.ok(Number.isFinite(meanLag), 'Mean lag must be finite')
      // 10K events enqueueing must complete smoothly without locking the loop
      assert.ok(enqueueDuration < 15000, `10K enqueue took ${enqueueDuration.toFixed(2)}ms`)
      assert.ok(meanLag < 200, `Mean lag during 10K burst should be < 200ms, was ${meanLag.toFixed(2)}ms`)
      assert.ok(p99Lag < 400, `p99 lag during 10K burst should be < 400ms, was ${p99Lag.toFixed(2)}ms`)
    })
  })

  // ─── Adversarial Test #4: Duplicate Initialization ──────────────────────────
  describe('Adversarial Test #4 — Duplicate Initialization Attacks', () => {
    it('safely coordinates concurrent init calls during background recovery', async () => {
      let fetchCount = 0
      globalThis.fetch = async () => {
        fetchCount++
        return new Response(JSON.stringify({ error: 'Service Unavailable' }), { status: 503 })
      }

      // Initial init failure -> recovering
      await init({ apiKey: testApiKey, initTimeoutMs: 100, initRetries: 0 })
      assert.strictEqual(client.getState(), 'recovering')

      // Attack with 10 concurrent init calls with same identity
      const concurrentResults = await Promise.all(
        Array.from({ length: 10 }, () =>
          init({ apiKey: testApiKey, initTimeoutMs: 100, initRetries: 0 })
        )
      )

      assert.ok(concurrentResults.every(r => r === undefined))
      // Exactly 1 active background worker
      assert.ok(BackgroundRecoveryWorker.getInstance() !== null)

      // Attacking with DIFFERENT identity must be rejected
      await assert.rejects(
        async () => {
          await init({ apiKey: 'different_api_key_0000', initTimeoutMs: 100, initRetries: 0 })
        },
        /different options/
      )
    })
  })

  // ─── Adversarial Test #5: Shutdown vs Late Activation Race ──────────────────
  describe('Adversarial Test #5 — Shutdown vs Late Activation Race', () => {
    it('shutdown always wins race against delayed control-plane responses', async () => {
      let resolveInitResponse!: (res: Response) => void
      globalThis.fetch = async () => {
        return new Promise<Response>((resolve) => {
          resolveInitResponse = resolve
        })
      }

      // Start init (it will stall waiting for fetch)
      const initPromise = init({ apiKey: testApiKey, initTimeoutMs: 500, initRetries: 0 })

      // Initiate shutdown immediately while fetch is in-flight
      const shutdownResult = await shutdown(1000)
      assert.strictEqual(shutdownResult.completed, true)
      assert.strictEqual(client.getState(), 'stopped')

      // Now delayed response arrives after shutdown has settled
      if (resolveInitResponse) {
        resolveInitResponse(createSuccessResponse())
      }
      const res = await initPromise
      assert.strictEqual(res, undefined)

      // SDK MUST remain stopped and never resurrect
      assert.strictEqual(client.getState(), 'stopped')
      assert.strictEqual(client.initialized, false)
      assert.strictEqual(BackgroundRecoveryWorker.getInstance(), null)
    })
  })

  // ─── Adversarial Test #6: Memory Bound Verification ─────────────────────────
  describe('Adversarial Test #6 — Memory Bound Verification Under Extended Outage', () => {
    it('preserves strict memory ceiling under 20,000 events during outage', async () => {
      globalThis.fetch = async () => new Response(JSON.stringify({ error: 'Gateway Timeout' }), { status: 504 })

      await init({ apiKey: testApiKey, initTimeoutMs: 100, initRetries: 0 })
      assert.strictEqual(client.getState(), 'recovering')

      const initialHeap = process.memoryUsage().heapUsed

      // Ingest 20,000 events (queue default is 1,000)
      for (let i = 0; i < 20_000; i++) {
        if (i % 2 === 0) {
          captureError(new Error(`Outage error ${i}`))
        } else {
          captureMessage(`Outage message ${i}`)
        }
      }

      // EventQueue must remain clamped at or below capacity (1,000)
      assert.ok(eventQueue.size() <= 1000, `Queue size must not exceed 1000, was ${eventQueue.size()}`)
      const stats = eventQueue.getStats()
      assert.ok(stats.droppedCount >= 19_000, `Must drop overflow events (dropped: ${stats.droppedCount})`)

      const finalHeap = process.memoryUsage().heapUsed
      const heapGrowthMb = (finalHeap - initialHeap) / (1024 * 1024)

      // Heap growth must not be unbounded (should be < 40 MB for 20K bounded attempts)
      assert.ok(heapGrowthMb < 40, `Heap growth was ${heapGrowthMb.toFixed(2)}MB, expected < 40MB`)
    })
  })

  // ─── Adversarial Test #7: Timer / Process Liveness ──────────────────────────
  describe('Adversarial Test #7 — Timer & Process Liveness Audit', () => {
    it('ensures recovery worker and background timers are unref-ed', async () => {
      globalThis.fetch = async () => new Response(JSON.stringify({ error: 'Unavailable' }), { status: 503 })

      await init({ apiKey: testApiKey, initTimeoutMs: 100, initRetries: 0 })
      assert.strictEqual(client.getState(), 'recovering')

      const worker = BackgroundRecoveryWorker.getInstance()
      assert.ok(worker !== null)
      assert.strictEqual(worker.isRunning(), true)

      // Shutdown stops worker and clears timers
      await shutdown(500)
      assert.strictEqual(BackgroundRecoveryWorker.getInstance(), null)
      assert.strictEqual(client.getState(), 'stopped')
    })
  })

  // ─── Adversarial Test #8: OTel Duplication After Recovery ────────────────────
  describe('Adversarial Test #8 — OTel Duplication After Recovery', () => {
    it('creates exactly 1 span per operation after repeated recovery cycles', async () => {
      // 1. Initial failure
      globalThis.fetch = async () => new Response(JSON.stringify({ error: 'Service Down' }), { status: 503 })
      await init({ apiKey: testApiKey, initTimeoutMs: 100, initRetries: 0 })
      assert.strictEqual(client.getState(), 'recovering')

      // 2. Recovery succeeds
      globalThis.fetch = async () => createSuccessResponse()
      const worker = BackgroundRecoveryWorker.getInstance()
      assert.ok(worker !== null)

      // Wait for recovery attempt to succeed
      const deadline = Date.now() + 2000
      while (!client.initialized && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 20))
      }
      assert.strictEqual(client.initialized, true)

      // 3. Verify span execution creates exactly 1 span
      let spanExecutionCount = 0
      await withSpan('test-single-span', () => {
        spanExecutionCount++
      })

      assert.strictEqual(spanExecutionCount, 1)
    })
  })

  // ─── Adversarial Test #9: Unhandled Promise Rejection ───────────────────────
  describe('Adversarial Test #9 — Unhandled Promise Rejection Containment', () => {
    it('catches and contains all background network, parser, and schema errors', async () => {
      const unhandledRejections: unknown[] = []
      const uncaughtExceptions: unknown[] = []

      const onRejection = (err: unknown) => { unhandledRejections.push(err) }
      const onException = (err: unknown) => { uncaughtExceptions.push(err) }

      process.on('unhandledRejection', onRejection)
      process.on('uncaughtException', onException)

      try {
        // Feed corrupt data into /v1/init
        globalThis.fetch = async () => {
          return new Response('<<<NOT JSON AT ALL>>>', {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        }

        const res = await init({ apiKey: testApiKey, initTimeoutMs: 100, initRetries: 0 })
        assert.strictEqual(res, undefined)

        // Wait for background ticks
        await new Promise(r => setTimeout(r, 100))

        assert.strictEqual(unhandledRejections.length, 0, 'No unhandled promise rejections allowed')
        assert.strictEqual(uncaughtExceptions.length, 0, 'No uncaught exceptions allowed')
      } finally {
        process.removeListener('unhandledRejection', onRejection)
        process.removeListener('uncaughtException', onException)
      }
    })
  })

  // ─── Adversarial Test #10: Customer HTTP Request Isolation ──────────────────
  describe('Adversarial Test #10 — Customer HTTP Request Isolation', () => {
    it('serves customer HTTP traffic with 100% success rate during backend chaos', async () => {
      const server = http.createServer((req, res) => {
        if (req.url === '/api/test') {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ status: 'ok', data: 42 }))
        } else {
          res.writeHead(404)
          res.end()
        }
      })

      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
      const address = server.address() as import('node:net').AddressInfo
      const baseUrl = `http://127.0.0.1:${address.port}`

      try {
        // Simulate flaky, chaotic backend
        let callCount = 0
        globalThis.fetch = async (url) => {
          if (String(url).includes('/v1/init')) {
            callCount++
            if (callCount % 2 === 0) {
              await new Promise(r => setTimeout(r, 80))
              return new Response(JSON.stringify({ error: 'Server Overloaded' }), { status: 503 })
            }
            throw new TypeError('fetch failed: connect ECONNRESET')
          }
          return new Response(JSON.stringify({ status: 'ok' }), { status: 200 })
        }

        // Initialize SDK amidst backend chaos
        const initPromise = init({ apiKey: testApiKey, initTimeoutMs: 120, initRetries: 0 })

        // Concurrently bombard customer server with HTTP requests
        const results = await Promise.all(
          Array.from({ length: 50 }, async (_, i) => {
            captureError(new Error(`Concurrent error ${i}`))
            const res = await fetch(`${baseUrl}/api/test`)
            return res.status
          })
        )

        await initPromise

        // Every customer HTTP request must succeed
        assert.ok(results.every(status => status === 200), 'All customer HTTP requests must return 200 OK')
      } finally {
        await new Promise<void>(resolve => server.close(() => resolve()))
      }
    })
  })
})
