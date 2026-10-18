import http from 'node:http'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { gunzipSync } from 'node:zlib'
import { init } from '../../src/core/init.js'
import { shutdown } from '../../src/core/lifecycle.js'
import { startSpan, withSpan } from '../../src/tracing/tracer.js'
import { captureException } from '../../src/capture/captureException.js'
import { captureMetric, incrementCounter, setGauge, recordHistogram } from '../../src/capture/captureMetric.js'
import { captureMessage } from '../../src/capture/captureMessage.js'
import { addBreadcrumb, getTraceId } from '../../src/core/context.js'
import { setUser, setTag } from '../../src/core/scope.js'
import { TEST_REMOTE_CONFIG as BAKED_IN_REMOTE_CONFIG } from '../fixtures/remote-config.js'

export interface MicrobenchmarkResult {
  operation: string
  iterations: number
  totalDurationMs: number
  avgLatencyUs: number
  p50Us: number
  p95Us: number
  p99Us: number
  maxUs: number
  opsPerSec: number
  cpuUserUs: number
  cpuSystemUs: number
  cpuTotalUs: number
  cpuPerOpUs: number
}

async function startMockTelemetryServer(): Promise<{ url: string; port: number; close(): Promise<void> }> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(Buffer.from(c)))
    req.on('end', () => {
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
        }
        const routes = Object.fromEntries(
          Object.entries(BAKED_IN_REMOTE_CONFIG.transport.routes).map(([name, route]) => [
            name,
            { ...route, url: `${localUrl}${routePaths[name]}`, batchSize: 500, flushIntervalMs: 50, timeoutMs: 2_000 },
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
                logging: false,
                profiling: false,
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

      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ success: true, processed: true }))
    })
  })

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  const port = (server.address() as { port: number }).port

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    close: async () => {
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}

function percentile(sortedArr: number[], p: number): number {
  if (sortedArr.length === 0) return 0
  const index = Math.min(Math.floor((p / 100) * sortedArr.length), sortedArr.length - 1)
  return sortedArr[index] ?? 0
}

export async function runMicrobenchmarks(iterations = 10_000): Promise<{
  initDurationMs: number
  eventLoopLag: { minMs: number; maxMs: number; meanMs: number; p50Ms: number; p95Ms: number; p99Ms: number }
  results: MicrobenchmarkResult[]
}> {
  const mockServer = await startMockTelemetryServer()
  process.env['PULSE_ENDPOINT'] = mockServer.url

  // 1. Measure Initialization Cost
  const initStart = performance.now()
  await init({
    apiKey: 'pv_live_audit_test_key_123456789012345678901234.abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
    initTimeoutMs: 3_000,
  })
  const initDurationMs = performance.now() - initStart

  const lagMonitor = monitorEventLoopDelay({ resolution: 20 })
  lagMonitor.enable()

  const operations: Array<{ name: string; fn: (i: number) => void | Promise<void> }> = [
    {
      name: 'addBreadcrumb',
      fn: i => {
        addBreadcrumb({ category: 'audit', message: `Breadcrumb ${i}`, level: 'info' })
      },
    },
    {
      name: 'setUser & setTag',
      fn: i => {
        setUser({ id: `user_${i}`, email: `user_${i}@example.com` })
        setTag('env', 'production')
        setTag('tier', 'gold')
      },
    },
    {
      name: 'getTraceId',
      fn: () => {
        getTraceId()
      },
    },
    {
      name: 'captureMetric (incrementCounter)',
      fn: i => {
        incrementCounter('test_counter_total', 1, { status: i % 2 === 0 ? 'ok' : 'fail' })
      },
    },
    {
      name: 'captureMetric (recordHistogram)',
      fn: i => {
        recordHistogram('test_latency_ms', i % 100, { route: '/api/v1/users' })
      },
    },
    {
      name: 'captureMessage',
      fn: i => {
        captureMessage(`Audit telemetry message ${i}`, 'info', { loopIndex: i })
      },
    },
    {
      name: 'startSpan & span.end()',
      fn: i => {
        const span = startSpan(`audit.operation.${i % 10}`)
        span.setAttribute('audit.index', i)
        span.setAttribute('audit.flag', true)
        span.end()
      },
    },
    {
      name: 'withSpan async wrapper',
      fn: async i => {
        await withSpan(`audit.async.${i % 10}`, async span => {
          span.setAttribute('test.step', 1)
          return 42
        })
      },
    },
    {
      name: 'captureException (with stack trace)',
      fn: i => {
        const error = new Error(`Audit generated error ${i}`)
        captureException(error)
      },
    },
  ]

  const results: MicrobenchmarkResult[] = []

  for (const op of operations) {
    const warmupCount = Math.min(500, Math.floor(iterations / 10))
    for (let w = 0; w < warmupCount; w++) {
      const res = op.fn(w)
      if (res instanceof Promise) await res
    }

    const latenciesUs: number[] = new Array(iterations)
    const cpuStart = process.cpuUsage()
    const startHr = process.hrtime.bigint()

    for (let i = 0; i < iterations; i++) {
      const callStart = process.hrtime.bigint()
      const res = op.fn(i)
      if (res instanceof Promise) await res
      const callEnd = process.hrtime.bigint()
      latenciesUs[i] = Number(callEnd - callStart) / 1_000 // microseconds
    }

    const endHr = process.hrtime.bigint()
    const cpuDelta = process.cpuUsage(cpuStart)
    const totalDurationMs = Number(endHr - startHr) / 1_000_000

    latenciesUs.sort((a, b) => a - b)

    const avgLatencyUs = latenciesUs.reduce((sum, v) => sum + v, 0) / iterations
    const p50Us = percentile(latenciesUs, 50)
    const p95Us = percentile(latenciesUs, 95)
    const p99Us = percentile(latenciesUs, 99)
    const maxUs = latenciesUs[latenciesUs.length - 1] ?? 0
    const opsPerSec = Math.round((iterations / (totalDurationMs / 1000)))

    const cpuUserUs = cpuDelta.user
    const cpuSystemUs = cpuDelta.system
    const cpuTotalUs = cpuUserUs + cpuSystemUs
    const cpuPerOpUs = cpuTotalUs / iterations

    results.push({
      operation: op.name,
      iterations,
      totalDurationMs: Math.round(totalDurationMs * 100) / 100,
      avgLatencyUs: Math.round(avgLatencyUs * 100) / 100,
      p50Us: Math.round(p50Us * 100) / 100,
      p95Us: Math.round(p95Us * 100) / 100,
      p99Us: Math.round(p99Us * 100) / 100,
      maxUs: Math.round(maxUs * 100) / 100,
      opsPerSec,
      cpuUserUs,
      cpuSystemUs,
      cpuTotalUs,
      cpuPerOpUs: Math.round(cpuPerOpUs * 100) / 100,
    })
  }

  const nsToMs = (ns: number) => Math.round((ns / 1_000_000) * 100) / 100
  const eventLoopLag = {
    minMs: nsToMs(lagMonitor.min),
    maxMs: nsToMs(lagMonitor.max),
    meanMs: nsToMs(lagMonitor.mean),
    p50Ms: nsToMs(lagMonitor.percentile(50)),
    p95Ms: nsToMs(lagMonitor.percentile(95)),
    p99Ms: nsToMs(lagMonitor.percentile(99)),
  }

  lagMonitor.disable()
  await shutdown(3_000)
  await mockServer.close()

  return {
    initDurationMs: Math.round(initDurationMs * 100) / 100,
    eventLoopLag,
    results,
  }
}
