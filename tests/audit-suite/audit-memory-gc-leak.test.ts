import http from 'node:http'
import { PerformanceObserver } from 'node:perf_hooks'
import { init } from '../../src/core/init.js'
import { shutdown } from '../../src/core/lifecycle.js'
import { startSpan } from '../../src/tracing/tracer.js'
import { captureException } from '../../src/capture/captureException.js'
import { captureMetric, incrementCounter } from '../../src/capture/captureMetric.js'
import { captureMessage } from '../../src/capture/captureMessage.js'
import { TEST_REMOTE_CONFIG as BAKED_IN_REMOTE_CONFIG } from '../fixtures/remote-config.js'

export interface MemoryAuditResult {
  totalOperations: number
  heapInitialMb: number
  heapPeakMb: number
  heapPostLoadMb: number
  heapFinalPostGcMb: number
  rssInitialMb: number
  rssPeakMb: number
  rssFinalMb: number
  heapGrowthMb: number
  retainedLeakBytes: number
  isLeakSuspected: boolean
  gcPauses: {
    count: number
    totalDurationMs: number
    maxDurationMs: number
    avgDurationMs: number
  }
  activeHandlesAfterShutdown: number
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

export async function runMemoryGCAudit(totalOperations = 10_000): Promise<MemoryAuditResult> {
  const mockServer = await startMockTelemetryServer()
  process.env['PULSE_ENDPOINT'] = mockServer.url

  // Track GC activity
  let gcCount = 0
  let gcTotalDurationMs = 0
  let gcMaxDurationMs = 0

  const gcObserver = new PerformanceObserver(list => {
    for (const entry of list.getEntries()) {
      gcCount++
      gcTotalDurationMs += entry.duration
      if (entry.duration > gcMaxDurationMs) {
        gcMaxDurationMs = entry.duration
      }
    }
  })

  try {
    gcObserver.observe({ entryTypes: ['gc'] })
  } catch {
    // GC observation may require node flags or not supported on some platforms
  }

  // Baseline memory before init
  if (typeof global.gc === 'function') global.gc()
  const memInitial = process.memoryUsage()

  await init({
    apiKey: 'pv_live_audit_test_key_123456789012345678901234.abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
    initTimeoutMs: 3_000,
  })

  let peakHeapUsed = 0
  let peakRss = 0

  const toMb = (bytes: number) => Math.round((bytes / 1024 / 1024) * 100) / 100

  // Run sustained telemetry operations
  for (let i = 0; i < totalOperations; i++) {
    // 1. Spans
    const span = startSpan(`audit.soak.span.${i % 20}`)
    span.setAttribute('audit.iteration', i)
    span.setAttribute('audit.even', i % 2 === 0)
    span.end()

    // 2. Metrics
    incrementCounter('audit_soak_counter', 1, { iteration_mod: String(i % 5) })

    // 3. Messages
    if (i % 5 === 0) {
      captureMessage(`Audit soak message ${i}`, 'info', { step: i })
    }

    // 4. Errors
    if (i % 10 === 0) {
      captureException(new Error(`Audit soak error ${i}`))
    }

    // Periodic memory sampling
    if (i % 500 === 0) {
      const currentMem = process.memoryUsage()
      if (currentMem.heapUsed > peakHeapUsed) peakHeapUsed = currentMem.heapUsed
      if (currentMem.rss > peakRss) peakRss = currentMem.rss
      // Yield to event loop to allow transport batches to drain
      await new Promise<void>(resolve => setImmediate(resolve))
    }
  }

  const memPostLoad = process.memoryUsage()
  if (memPostLoad.heapUsed > peakHeapUsed) peakHeapUsed = memPostLoad.heapUsed
  if (memPostLoad.rss > peakRss) peakRss = memPostLoad.rss

  // Shutdown SDK and drain all queues
  await shutdown(5_000)
  await mockServer.close()

  // Clean GC
  if (typeof global.gc === 'function') {
    global.gc()
    global.gc()
  }

  const memFinal = process.memoryUsage()
  gcObserver.disconnect()

  const retainedLeakBytes = Math.max(0, memFinal.heapUsed - memInitial.heapUsed)
  // An SDK memory leak is flagged if net retained heap exceeds 5MB after full shutdown and GC
  const isLeakSuspected = retainedLeakBytes > 5 * 1024 * 1024

  const activeHandles = (process as any)._getActiveHandles ? (process as any)._getActiveHandles().length : 0

  return {
    totalOperations,
    heapInitialMb: toMb(memInitial.heapUsed),
    heapPeakMb: toMb(peakHeapUsed),
    heapPostLoadMb: toMb(memPostLoad.heapUsed),
    heapFinalPostGcMb: toMb(memFinal.heapUsed),
    rssInitialMb: toMb(memInitial.rss),
    rssPeakMb: toMb(peakRss),
    rssFinalMb: toMb(memFinal.rss),
    heapGrowthMb: toMb(retainedLeakBytes),
    retainedLeakBytes,
    isLeakSuspected,
    gcPauses: {
      count: gcCount,
      totalDurationMs: Math.round(gcTotalDurationMs * 100) / 100,
      maxDurationMs: Math.round(gcMaxDurationMs * 100) / 100,
      avgDurationMs: gcCount > 0 ? Math.round((gcTotalDurationMs / gcCount) * 100) / 100 : 0,
    },
    activeHandlesAfterShutdown: activeHandles,
  }
}
