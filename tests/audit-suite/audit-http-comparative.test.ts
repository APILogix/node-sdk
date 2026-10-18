import http from 'node:http'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import express from 'express'
import { init } from '../../src/core/init.js'
import { shutdown } from '../../src/core/lifecycle.js'
import { pulseMiddleware } from '../../src/instrumentation/express.js'
import { TEST_REMOTE_CONFIG as BAKED_IN_REMOTE_CONFIG } from '../fixtures/remote-config.js'

export interface HttpComparisonResult {
  concurrency: number
  totalRequests: number
  baseline: {
    rps: number
    durationMs: number
    p50Ms: number
    p95Ms: number
    p99Ms: number
    maxMs: number
    meanMs: number
    cpuTotalUs: number
    eventLoopLagP99Ms: number
  }
  withSdk: {
    rps: number
    durationMs: number
    p50Ms: number
    p95Ms: number
    p99Ms: number
    maxMs: number
    meanMs: number
    cpuTotalUs: number
    eventLoopLagP99Ms: number
  }
  delta: {
    rpsChangePercent: number
    latencyP50DeltaMs: number
    latencyP95DeltaMs: number
    latencyP99DeltaMs: number
    addedLatencyMeanMs: number
    cpuIncreasePercent: number
  }
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

async function runLoadAgainstServer(
  targetPort: number,
  totalRequests: number,
  concurrency: number
): Promise<{
  rps: number
  durationMs: number
  p50Ms: number
  p95Ms: number
  p99Ms: number
  maxMs: number
  meanMs: number
  cpuTotalUs: number
  eventLoopLagP99Ms: number
}> {
  const agent = new http.Agent({ keepAlive: true, maxSockets: concurrency })
  const latenciesMs: number[] = []
  let completed = 0

  const lagMonitor = monitorEventLoopDelay({ resolution: 20 })
  lagMonitor.enable()

  const cpuStart = process.cpuUsage()
  const startTime = performance.now()

  await new Promise<void>((resolve, reject) => {
    let nextReqIndex = 0

    const launchWorker = () => {
      if (completed >= totalRequests) {
        resolve()
        return
      }
      if (nextReqIndex >= totalRequests) return

      nextReqIndex++
      const reqStart = performance.now()

      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: targetPort,
          path: '/api/v1/orders/12345?fields=id,items,total',
          method: 'GET',
          agent,
          headers: {
            'content-type': 'application/json',
            'x-request-id': `bench_req_${nextReqIndex}`,
            'x-tenant-id': 'tenant_corp',
          },
        },
        res => {
          res.on('data', () => {})
          res.on('end', () => {
            const reqEnd = performance.now()
            latenciesMs.push(reqEnd - reqStart)
            completed++

            if (completed >= totalRequests) {
              resolve()
            } else {
              launchWorker()
            }
          })
        }
      )

      req.on('error', err => {
        completed++
        if (completed >= totalRequests) resolve()
        else launchWorker()
      })

      req.end()
    }

    for (let c = 0; c < concurrency; c++) {
      launchWorker()
    }
  })

  const endTime = performance.now()
  const cpuDelta = process.cpuUsage(cpuStart)
  const durationMs = endTime - startTime
  const rps = Math.round((totalRequests / (durationMs / 1000)))

  latenciesMs.sort((a, b) => a - b)
  const meanMs = latenciesMs.reduce((a, b) => a + b, 0) / (latenciesMs.length || 1)
  const p50Ms = percentile(latenciesMs, 50)
  const p95Ms = percentile(latenciesMs, 95)
  const p99Ms = percentile(latenciesMs, 99)
  const maxMs = latenciesMs[latenciesMs.length - 1] ?? 0

  const nsToMs = (ns: number) => Math.round((ns / 1_000_000) * 100) / 100
  const eventLoopLagP99Ms = nsToMs(lagMonitor.percentile(99))
  lagMonitor.disable()
  agent.destroy()

  return {
    rps,
    durationMs: Math.round(durationMs * 100) / 100,
    p50Ms: Math.round(p50Ms * 100) / 100,
    p95Ms: Math.round(p95Ms * 100) / 100,
    p99Ms: Math.round(p99Ms * 100) / 100,
    maxMs: Math.round(maxMs * 100) / 100,
    meanMs: Math.round(meanMs * 100) / 100,
    cpuTotalUs: cpuDelta.user + cpuDelta.system,
    eventLoopLagP99Ms,
  }
}

export async function runHttpComparativeBenchmark(tiers = [
  { concurrency: 1, requests: 1_000 },
  { concurrency: 10, requests: 2_500 },
  { concurrency: 50, requests: 5_000 },
  { concurrency: 100, requests: 5_000 },
]): Promise<HttpComparisonResult[]> {
  const results: HttpComparisonResult[] = []

  for (const tier of tiers) {
    // ── Phase 1: Pure Baseline Express Server (No SDK) ────────────────────────
    const baselineApp = express()
    baselineApp.get('/api/v1/orders/:id', (req, res) => {
      // Simulate realistic route business logic (parsing params, JSON serialization)
      res.json({
        id: req.params.id,
        items: [{ sku: 'PROD-1', quantity: 2, price: 49.99 }, { sku: 'PROD-2', quantity: 1, price: 99.00 }],
        total: 198.98,
        status: 'pending',
        timestamp: Date.now(),
      })
    })

    const baselineServer = http.createServer(baselineApp)
    await new Promise<void>(resolve => baselineServer.listen(0, '127.0.0.1', () => resolve()))
    const baselinePort = (baselineServer.address() as { port: number }).port

    // Warmup baseline
    await runLoadAgainstServer(baselinePort, 200, tier.concurrency)
    // Run measured baseline
    const baselineMetrics = await runLoadAgainstServer(baselinePort, tier.requests, tier.concurrency)

    await new Promise<void>(resolve => baselineServer.close(() => resolve()))

    // ── Phase 2: Express Server with Pulse SDK Active ─────────────────────────
    const mockTelemetryServer = await startMockTelemetryServer()
    process.env['PULSE_ENDPOINT'] = mockTelemetryServer.url

    await init({
      apiKey: 'pv_live_audit_test_key_123456789012345678901234.abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
      initTimeoutMs: 3_000,
    })

    const sdkApp = express()
    sdkApp.use(pulseMiddleware({
      ignorePaths: ['/healthz'],
    }))

    sdkApp.get('/api/v1/orders/:id', (req, res) => {
      res.json({
        id: req.params.id,
        items: [{ sku: 'PROD-1', quantity: 2, price: 49.99 }, { sku: 'PROD-2', quantity: 1, price: 99.00 }],
        total: 198.98,
        status: 'pending',
        timestamp: Date.now(),
      })
    })

    const sdkServer = http.createServer(sdkApp)
    await new Promise<void>(resolve => sdkServer.listen(0, '127.0.0.1', () => resolve()))
    const sdkPort = (sdkServer.address() as { port: number }).port

    // Warmup SDK
    await runLoadAgainstServer(sdkPort, 200, tier.concurrency)
    // Run measured SDK
    const withSdkMetrics = await runLoadAgainstServer(sdkPort, tier.requests, tier.concurrency)

    await new Promise<void>(resolve => sdkServer.close(() => resolve()))
    await shutdown(3_000)
    await mockTelemetryServer.close()

    // ── Phase 3: Compute Comparative Deltas ───────────────────────────────────
    const rpsChangePercent = Math.round(((withSdkMetrics.rps - baselineMetrics.rps) / baselineMetrics.rps) * 1000) / 10
    const latencyP50DeltaMs = Math.round((withSdkMetrics.p50Ms - baselineMetrics.p50Ms) * 100) / 100
    const latencyP95DeltaMs = Math.round((withSdkMetrics.p95Ms - baselineMetrics.p95Ms) * 100) / 100
    const latencyP99DeltaMs = Math.round((withSdkMetrics.p99Ms - baselineMetrics.p99Ms) * 100) / 100
    const addedLatencyMeanMs = Math.round((withSdkMetrics.meanMs - baselineMetrics.meanMs) * 100) / 100
    const cpuIncreasePercent = Math.round(((withSdkMetrics.cpuTotalUs - baselineMetrics.cpuTotalUs) / (baselineMetrics.cpuTotalUs || 1)) * 1000) / 10

    results.push({
      concurrency: tier.concurrency,
      totalRequests: tier.requests,
      baseline: baselineMetrics,
      withSdk: withSdkMetrics,
      delta: {
        rpsChangePercent,
        latencyP50DeltaMs,
        latencyP95DeltaMs,
        latencyP99DeltaMs,
        addedLatencyMeanMs,
        cpuIncreasePercent,
      },
    })
  }

  return results
}
