import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { init, shutdown, captureError, captureMessage } from '../../src/index.js'
import { client } from '../../src/core/client.js'
import { eventQueue } from '../../src/transport/queue.js'
import { BackgroundRecoveryWorker, getDefaultBaseDelayMs } from '../../src/core/recovery-worker.js'
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

describe('Pulse SDK — Event-Loop Safety, Recovery Delay & Operational Risks', () => {
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
    delete process.env['NODE_ENV']
    delete process.env['PULSE_ENV']
    BackgroundRecoveryWorker.stop()
  })

  describe('Risk #2 — Test Recovery Delay Hardening', () => {
    it('returns 1000ms by default when env var is not set', () => {
      delete process.env['PULSE_TEST_RECOVERY_DELAY_MS']
      delete process.env['NODE_ENV']
      delete process.env['PULSE_ENV']
      assert.strictEqual(getDefaultBaseDelayMs(), 1_000)
    })

    it('ignores PULSE_TEST_RECOVERY_DELAY_MS when NODE_ENV=production', () => {
      process.env['NODE_ENV'] = 'production'
      process.env['PULSE_TEST_RECOVERY_DELAY_MS'] = '10'
      assert.strictEqual(getDefaultBaseDelayMs(), 1_000, 'Must ignore test delay in production')
    })

    it('ignores PULSE_TEST_RECOVERY_DELAY_MS when PULSE_ENV=production', () => {
      delete process.env['NODE_ENV']
      process.env['PULSE_ENV'] = 'production'
      process.env['PULSE_TEST_RECOVERY_DELAY_MS'] = '10'
      assert.strictEqual(getDefaultBaseDelayMs(), 1_000, 'Must ignore test delay in production')
    })

    it('falls back to 1000ms if PULSE_TEST_RECOVERY_DELAY_MS is non-numeric or NaN', () => {
      delete process.env['NODE_ENV']
      process.env['PULSE_TEST_RECOVERY_DELAY_MS'] = 'invalid_number'
      assert.strictEqual(getDefaultBaseDelayMs(), 1_000)
      process.env['PULSE_TEST_RECOVERY_DELAY_MS'] = 'NaN'
      assert.strictEqual(getDefaultBaseDelayMs(), 1_000)
    })

    it('falls back to 1000ms if PULSE_TEST_RECOVERY_DELAY_MS is zero or negative', () => {
      delete process.env['NODE_ENV']
      process.env['PULSE_TEST_RECOVERY_DELAY_MS'] = '0'
      assert.strictEqual(getDefaultBaseDelayMs(), 1_000)
      process.env['PULSE_TEST_RECOVERY_DELAY_MS'] = '-100'
      assert.strictEqual(getDefaultBaseDelayMs(), 1_000)
    })

    it('accepts safe test delay values in non-production environments', () => {
      delete process.env['NODE_ENV']
      process.env['PULSE_TEST_RECOVERY_DELAY_MS'] = '25'
      assert.strictEqual(getDefaultBaseDelayMs(), 25)
    })

    it('clamps test delay to safe minimum (10ms) and maximum (60,000ms)', () => {
      delete process.env['NODE_ENV']
      process.env['PULSE_TEST_RECOVERY_DELAY_MS'] = '2'
      assert.strictEqual(getDefaultBaseDelayMs(), 10, 'Clamped to minimum 10ms')

      process.env['PULSE_TEST_RECOVERY_DELAY_MS'] = '120000'
      assert.strictEqual(getDefaultBaseDelayMs(), 60_000, 'Clamped to maximum 60,000ms')
    })
  })

  describe('Event-Loop Delay Monitoring (perf_hooks)', () => {
    it('maintains low event-loop lag across SDK initialization, recovery, and high telemetry volume', async () => {
      const histogram = monitorEventLoopDelay({ resolution: 10 })
      histogram.enable()

      // Phase 1: Establish baseline lag (SDK disabled/idle)
      await new Promise(r => setTimeout(r, 100))
      const baselineMean = histogram.mean / 1e6
      const baselineP99 = histogram.percentile(99) / 1e6

      // Phase 2: Failed /v1/init -> background recovery active
      let fetchCount = 0
      globalThis.fetch = async () => {
        fetchCount++
        return new Response(JSON.stringify({ error: 'temporarily unavailable' }), { status: 503 })
      }

      const initStart = performance.now()
      await init({ apiKey: testApiKey, initTimeoutMs: 100, initRetries: 0 })
      const initDuration = performance.now() - initStart

      // Verify init did not block customer app startup
      assert.ok(initDuration < 500, `Init should complete quickly, took ${initDuration}ms`)
      assert.strictEqual(client.getState(), 'recovering')

      const recoveryMean = histogram.mean / 1e6
      const recoveryP99 = histogram.percentile(99) / 1e6

      // Phase 3: High telemetry volume (1,000 events)
      for (let i = 0; i < 1000; i++) {
        if (i % 2 === 0) {
          captureError(new Error(`Test error ${i}`))
        } else {
          captureMessage(`Test message ${i}`)
        }
        // Yield periodically as a realistic application would across ticks
        if ((i + 1) % 200 === 0) {
          await new Promise(r => setTimeout(r, 10))
        }
      }

      // Wait 150ms for recovery worker attempts to run in background
      await new Promise(r => setTimeout(r, 150))
      assert.ok(fetchCount >= 2, 'Recovery worker should have attempted background retries')

      // Phase 4: Compute final event loop delay
      const highLoadMean = histogram.mean / 1e6
      const highLoadP99 = histogram.percentile(99) / 1e6
      const highLoadMax = histogram.max / 1e6
      histogram.disable()

      // Node.js event-loop lag should remain bounded (mean under 50ms, p99 under 150ms)
      assert.ok(highLoadMean < 50, `Event loop mean lag should be < 50ms, was ${highLoadMean.toFixed(2)}ms`)
      assert.ok(highLoadP99 < 150, `Event loop p99 lag should be < 150ms, was ${highLoadP99.toFixed(2)}ms`)

      // Verify stats progression
      assert.ok(Number.isFinite(baselineMean))
      assert.ok(Number.isFinite(recoveryMean))
      assert.ok(Number.isFinite(highLoadMean))
    })
  })

  describe('Customer Request Path Unblocked (HTTP Server)', () => {
    it('customer HTTP server serves GET /health with low latency during SDK init failure & recovery', async () => {
      // Setup customer HTTP server
      const server = http.createServer((req, res) => {
        if (req.url === '/health') {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }))
        } else {
          res.writeHead(404)
          res.end()
        }
      })

      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
      const address = server.address() as import('node:net').AddressInfo
      const baseUrl = `http://127.0.0.1:${address.port}`

      try {
        // Mock backend /v1/init as slow and failing
        globalThis.fetch = async (url) => {
          if (String(url).includes('/v1/init')) {
            await new Promise(r => setTimeout(r, 100))
            return new Response(JSON.stringify({ error: 'Internal Server Error' }), { status: 500 })
          }
          return new Response(JSON.stringify({ status: 'ok' }), { status: 200 })
        }

        // Concurrently initialize SDK and hit /health
        const initPromise = init({ apiKey: testApiKey, initTimeoutMs: 150, initRetries: 0 })

        const requestLatencies: number[] = []
        for (let i = 0; i < 20; i++) {
          const start = performance.now()
          const response = await fetch(`${baseUrl}/health`)
          const elapsed = performance.now() - start
          requestLatencies.push(elapsed)
          assert.strictEqual(response.status, 200)
          const body = await response.json() as { status: string }
          assert.strictEqual(body.status, 'ok')
        }

        await initPromise
        assert.strictEqual(client.getState(), 'recovering')

        // Send 200 events while querying /health
        for (let i = 0; i < 200; i++) {
          captureError(new Error(`Background error ${i}`))
        }

        for (let i = 0; i < 20; i++) {
          const start = performance.now()
          const response = await fetch(`${baseUrl}/health`)
          const elapsed = performance.now() - start
          requestLatencies.push(elapsed)
          assert.strictEqual(response.status, 200)
        }

        const avgLatency = requestLatencies.reduce((a, b) => a + b, 0) / requestLatencies.length
        assert.ok(avgLatency < 50, `Customer /health average latency must be < 50ms, was ${avgLatency.toFixed(2)}ms`)
      } finally {
        await new Promise<void>(resolve => server.close(() => resolve()))
      }
    })
  })

  describe('Bounded Memory & Queue Safety During Extended Outage', () => {
    it('strictly bounds event queue memory and drops lower priority events when backend is unreachable', async () => {
      globalThis.fetch = async () => new Response(JSON.stringify({ error: 'gateway timeout' }), { status: 504 })

      await init({ apiKey: testApiKey, initTimeoutMs: 100, initRetries: 0 })
      assert.strictEqual(client.getState(), 'recovering')

      // Emit 2,000 events (queue capacity is 1,000)
      for (let i = 0; i < 1000; i++) {
        captureMessage(`Low priority message ${i}`)
      }
      for (let i = 0; i < 1000; i++) {
        captureError(new Error(`High priority error ${i}`))
      }

      // Verify queue does not exceed its configured limit
      assert.ok(eventQueue.size() <= 1000, `Queue size must not exceed capacity (was ${eventQueue.size()})`)
      assert.ok(eventQueue.getStats().droppedCount > 0, 'Must record dropped events when capacity is exceeded')

      // Critical/high errors should be preserved over messages
      assert.ok(eventQueue.getStats().criticalSize > 0 || eventQueue.getStats().highSize > 0)
    })
  })

  describe('Risk #1 — Graceful Shutdown vs Forced Termination Guarantees', () => {
    it('graceful shutdown cancels recovery worker, aborts operations, and sets terminal stopped state', async () => {
      let recoveryAttempts = 0
      globalThis.fetch = async () => {
        recoveryAttempts++
        return new Response(JSON.stringify({ error: 'down' }), { status: 503 })
      }

      await init({ apiKey: testApiKey, initTimeoutMs: 100, initRetries: 0 })
      assert.strictEqual(client.getState(), 'recovering')
      assert.ok(BackgroundRecoveryWorker.getInstance() !== null)

      // Graceful shutdown
      const result = await shutdown(2000)
      assert.strictEqual(result.completed, true)
      assert.strictEqual(client.getState(), 'stopped')
      assert.strictEqual(BackgroundRecoveryWorker.getInstance(), null)

      const attemptsAtShutdown = recoveryAttempts
      await new Promise(r => setTimeout(r, 100))
      assert.strictEqual(recoveryAttempts, attemptsAtShutdown, 'No further recovery attempts after shutdown')
    })

    it('does not allow recovery worker to reactivate SDK after shutdown has completed', async () => {
      globalThis.fetch = async () => createSuccessResponse()

      await init({ apiKey: testApiKey, initTimeoutMs: 100, initRetries: 0 })
      await shutdown(500)

      assert.strictEqual(client.getState(), 'stopped')
      // Ensure late activation cannot occur
      assert.strictEqual(client.initialized, false)
      assert.strictEqual(BackgroundRecoveryWorker.getInstance(), null)
    })
  })
})
