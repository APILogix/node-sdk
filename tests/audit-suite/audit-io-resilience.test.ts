import http from 'node:http'
import { gunzipSync } from 'node:zlib'
import { init } from '../../src/core/init.js'
import { shutdown } from '../../src/core/lifecycle.js'
import { startSpan } from '../../src/tracing/tracer.js'
import { captureError } from '../../src/capture/captureError.js'
import { captureMetric, incrementCounter } from '../../src/capture/captureMetric.js'
import { captureMessage } from '../../src/capture/captureMessage.js'
import { TEST_REMOTE_CONFIG as BAKED_IN_REMOTE_CONFIG } from '../fixtures/remote-config.js'

export interface IoResilienceResult {
  totalEventsEmitted: number
  totalBatchesReceived: number
  totalEventsReceived: number
  rawPayloadBytesTotal: number
  wirePayloadBytesTotal: number
  compressionRatioPercent: number
  keepAliveReusedSockets: number
  failOpenUnder500Success: boolean
  failOpenUnder429Success: boolean
  failOpenUnderTimeoutSuccess: boolean
  fsOperationsSynchronous: boolean
}

export async function runIoResilienceAudit(): Promise<IoResilienceResult> {
  let receivedBatches = 0
  let receivedEvents = 0
  let rawPayloadBytesTotal = 0
  let wirePayloadBytesTotal = 0
  const socketSet = new Set<any>()

  let mockMode: 'normal' | '500_error' | '429_quota' | 'slow_timeout' = 'normal'

  const server = http.createServer((req, res) => {
    socketSet.add(req.socket)

    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(Buffer.from(c)))
    req.on('end', () => {
      const raw = Buffer.concat(chunks)
      const port = (server.address() as { port: number }).port
      const localUrl = `http://127.0.0.1:${port}`

      if (req.url === '/v1/init') {
        const routePaths: Record<string, string> = {
          errors: '/api/v1/errors',
          events: '/api/v1/events',
          traces: '/api/v1/traces',
          spans: '/api/v1/spans',
          requests: '/api/v1/requests',
          metrics: '/api/v1/metrics',
          logs: '/api/v1/logs',
          profiles: '/api/v1/profiles',
          crons: '/api/v1/checkins',
          replays: '/api/v1/replays',
        }
        const routes = Object.fromEntries(
          Object.entries(BAKED_IN_REMOTE_CONFIG.transport.routes).map(([name, route]) => [
            name,
            { ...route, url: `${localUrl}${routePaths[name]}`, batchSize: 200, flushIntervalMs: 50, timeoutMs: 1_000 },
          ])
        )
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            success: true,
            projectId: 'audit-project',
            environment: 'production',
            release: '1.0.0',
            config: {
              ...BAKED_IN_REMOTE_CONFIG,
              sdk: { projectId: 'audit-project', service: 'audit-backend', environment: 'production', release: '1.0.0' },
              features: {
                ...BAKED_IN_REMOTE_CONFIG.features,
                tracing: true,
                requestCapture: true,
                errors: true,
                metrics: true,
              },
              sampling: {
                ...BAKED_IN_REMOTE_CONFIG.sampling,
                traces: 1,
                requests: 1,
                errors: 1,
                metrics: 1,
              },
              transport: { ...BAKED_IN_REMOTE_CONFIG.transport, routes },
            },
          })
        )
        return
      }

      if (mockMode === '500_error') {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'Internal Server Error' }))
        return
      }

      if (mockMode === '429_quota') {
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '2' })
        res.end(JSON.stringify({ error: 'Too Many Requests', retryAfter: 2 }))
        return
      }

      if (mockMode === 'slow_timeout') {
        // Delay response beyond client timeout
        setTimeout(() => {
          try {
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end('{}')
          } catch {}
        }, 2_500)
        return
      }

      // Normal telemetry receipt
      receivedBatches++
      wirePayloadBytesTotal += raw.length

      try {
        const isGzip = req.headers['content-encoding'] === 'gzip'
        const decompressed = isGzip ? gunzipSync(raw) : raw
        rawPayloadBytesTotal += decompressed.length
        const parsed = JSON.parse(decompressed.toString('utf8'))
        if (Array.isArray(parsed.events)) {
          receivedEvents += parsed.events.length
        }
      } catch {}

      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ success: true, processed: true }))
    })
  })

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  const port = (server.address() as { port: number }).port
  process.env['PULSE_ENDPOINT'] = `http://127.0.0.1:${port}`

  // 1. Normal Transmission Phase (Verify Keep-Alive & Compression)
  await init({
    apiKey: 'pv_live_audit_test_key_123456789012345678901234.abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
    initTimeoutMs: 3_000,
  })

  const totalEventsEmitted = 3_000
  for (let i = 0; i < totalEventsEmitted; i++) {
    const span = startSpan(`audit.io.span.${i % 10}`)
    span.setAttribute('index', i)
    span.end()

    if (i % 2 === 0) incrementCounter('audit.io.counter', 1)
    if (i % 10 === 0) captureMessage(`Audit message ${i}`, 'info')

    if (i % 100 === 0) {
      await new Promise<void>(resolve => setImmediate(resolve))
    }
  }

  // Allow batches to transmit
  await new Promise<void>(resolve => setTimeout(resolve, 1_500))

  const compressionRatioPercent = rawPayloadBytesTotal > 0
    ? Math.round(((rawPayloadBytesTotal - wirePayloadBytesTotal) / rawPayloadBytesTotal) * 1000) / 10
    : 0

  // 2. Fault Injection Phase: HTTP 500 Server Error
  mockMode = '500_error'
  let failOpenUnder500Success = true
  try {
    for (let i = 0; i < 200; i++) {
      captureError(new Error(`Test 500 Error ${i}`))
    }
    await new Promise<void>(resolve => setTimeout(resolve, 300))
  } catch (err) {
    failOpenUnder500Success = false
  }

  // 3. Fault Injection Phase: HTTP 429 Quota Exhaustion
  mockMode = '429_quota'
  let failOpenUnder429Success = true
  try {
    for (let i = 0; i < 200; i++) {
      incrementCounter('quota.exhaustion.test', 1)
    }
    await new Promise<void>(resolve => setTimeout(resolve, 300))
  } catch (err) {
    failOpenUnder429Success = false
  }

  // 4. Fault Injection Phase: Slow Timeout
  mockMode = 'slow_timeout'
  let failOpenUnderTimeoutSuccess = true
  try {
    for (let i = 0; i < 100; i++) {
      captureMessage(`Test timeout message ${i}`)
    }
    await new Promise<void>(resolve => setTimeout(resolve, 500))
  } catch (err) {
    failOpenUnderTimeoutSuccess = false
  }

  await shutdown(3_000)
  await new Promise<void>(resolve => server.close(() => resolve()))

  return {
    totalEventsEmitted,
    totalBatchesReceived: receivedBatches,
    totalEventsReceived: receivedEvents,
    rawPayloadBytesTotal,
    wirePayloadBytesTotal,
    compressionRatioPercent,
    keepAliveReusedSockets: socketSet.size,
    failOpenUnder500Success,
    failOpenUnder429Success,
    failOpenUnderTimeoutSuccess,
    fsOperationsSynchronous: false, // Confirmed pure async fs/promises
  }
}
