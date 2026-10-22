import http from 'node:http'
import { gzipSync } from 'node:zlib'
import { monitorEventLoopDelay, PerformanceObserver } from 'node:perf_hooks'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { init } from '../../src/core/init.js'
import { shutdown } from '../../src/core/lifecycle.js'
import { startSpan, withSpan } from '../../src/tracing/tracer.js'
import { costGovernor } from '../../src/utils/cost-governor.js'
import { TEST_REMOTE_CONFIG as BAKED_IN_REMOTE_CONFIG } from '../fixtures/remote-config.js'

export interface TierBenchmarkResult {
  tierName: string
  maxSpansPerTrace: number
  singleTrace: {
    spansGenerated: number
    durationMs: number
    avgLatencyPerSpanUs: number
    opsPerSec: number
    eventLoopLag: {
      minMs: number
      meanMs: number
      p50Ms: number
      p95Ms: number
      p99Ms: number
      maxMs: number
    }
    memory: {
      initialHeapMb: number
      peakHeapMb: number
      postTraceHeapMb: number
      postGcHeapMb: number
      netHeapGrowthMb: number
      initialRssMb: number
      peakRssMb: number
      finalRssMb: number
    }
    gc: {
      count: number
      totalDurationMs: number
      maxDurationMs: number
      avgDurationMs: number
    }
    wirePayload: {
      rawBytes: number
      rawKb: number
      wireGzipBytes: number
      wireGzipKb: number
      compressionRatioPercent: number
    }
  }
  concurrentLoad: {
    concurrency: number
    totalSpans: number
    durationMs: number
    throughputSpansPerSec: number
    eventLoopLagP99Ms: number
    peakHeapMb: number
    peakRssMb: number
    gcPauseCount: number
    gcTotalDurationMs: number
  }
  overflowEnforcement: {
    attemptedSpans: number
    admittedSpans: number
    blockedSpans: number
    enforcementSuccess: boolean
  }
}

let activeTierConfig = 500

async function startTierMockTelemetryServer(): Promise<{
  url: string
  port: number
  getReceivedPayloads: () => Buffer[]
  clearPayloads: () => void
  close: () => Promise<void>
}> {
  const receivedChunks: Buffer[] = []

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(Buffer.from(c)))
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks)
      if (rawBody.length > 0) {
        receivedChunks.push(rawBody)
      }

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
            { ...route, url: `${localUrl}${routePaths[name]}`, batchSize: 1000, flushIntervalMs: 50, timeoutMs: 3_000 },
          ])
        )

        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            success: true,
            projectId: `plan-tier-${activeTierConfig}`,
            environment: 'production',
            release: '1.0.0',
            config: {
              ...BAKED_IN_REMOTE_CONFIG,
              sdk: { projectId: `plan-tier-${activeTierConfig}`, service: 'benchmark-service', environment: 'production', release: '1.0.0' },
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
                spans: 1,
                requests: 1,
                errors: 1,
                metrics: 1,
              },
              limits: {
                ...BAKED_IN_REMOTE_CONFIG.limits,
                maxSpansPerTrace: activeTierConfig,
                maxQueueSize: 20_000,
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
    getReceivedPayloads: () => receivedChunks,
    clearPayloads: () => {
      receivedChunks.length = 0
    },
    close: async () => {
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}

function toMb(bytes: number): number {
  return Math.round((bytes / 1024 / 1024) * 100) / 100
}

export async function runSpanTierBenchmark(): Promise<TierBenchmarkResult[]> {
  const tiers = [
    { limit: 500, name: 'Tier 1: Starter (500 spans)' },
    { limit: 1_000, name: 'Tier 2: Growth (1,000 spans)' },
    { limit: 1_500, name: 'Tier 3: Business (1,500 spans)' },
    { limit: 2_000, name: 'Tier 4: Pro (2,000 spans)' },
    { limit: 5_000, name: 'Tier 5: Enterprise (5,000 spans)' },
  ]

  const mockServer = await startTierMockTelemetryServer()
  process.env['PULSE_ENDPOINT'] = mockServer.url

  const results: TierBenchmarkResult[] = []

  for (const tier of tiers) {
    console.log(`\n================================================================================`)
    console.log(`  EXECUTING BENCHMARK FOR ${tier.name}`)
    console.log(`================================================================================`)

    activeTierConfig = tier.limit
    mockServer.clearPayloads()

    if (typeof global.gc === 'function') {
      global.gc()
      global.gc()
    }

    const memInitial = process.memoryUsage()

    // 1. Initialize SDK with this tier's remote config
    await init({
      apiKey: 'pv_live_tier_test_key_123456789012345678901234.abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
      initTimeoutMs: 3_000,
    })

    // Track GC
    let gcCount = 0
    let gcTotalMs = 0
    let gcMaxMs = 0
    const gcObserver = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        gcCount++
        gcTotalMs += entry.duration
        if (entry.duration > gcMaxMs) gcMaxMs = entry.duration
      }
    })
    try {
      gcObserver.observe({ entryTypes: ['gc'] })
    } catch {}

    // Event Loop Lag Monitor
    const lagMonitor = monitorEventLoopDelay({ resolution: 20 })
    lagMonitor.enable()

    // -------------------------------------------------------------
    // SCENARIO 1: Single Deep Trace (exact limit)
    // -------------------------------------------------------------
    console.log(`  -> [Scenario 1] Generating single deep trace of ${tier.limit} spans...`)
    let peakHeapScenario1 = 0
    let peakRssScenario1 = 0

    const t0 = performance.now()
    await withSpan('http.server.request', async rootSpan => {
      rootSpan.setAttribute('http.method', 'POST')
      rootSpan.setAttribute('http.route', '/api/v1/checkout/process')
      rootSpan.setAttribute('customer.tier', tier.name)

      for (let i = 0; i < tier.limit - 1; i++) {
        const childSpan = startSpan(`db.query.item_${i % 10}`)
        childSpan.setAttribute('db.system', 'postgresql')
        childSpan.setAttribute('db.statement', `SELECT * FROM items WHERE id = ${i}`)
        childSpan.setAttribute('db.operation', 'SELECT')
        childSpan.setAttribute('span.index', i)
        childSpan.end()

        if (i % 250 === 0) {
          const mem = process.memoryUsage()
          if (mem.heapUsed > peakHeapScenario1) peakHeapScenario1 = mem.heapUsed
          if (mem.rss > peakRssScenario1) peakRssScenario1 = mem.rss
        }
      }
    })
    const durationSingleTraceMs = performance.now() - t0

    const memPostTrace = process.memoryUsage()
    if (memPostTrace.heapUsed > peakHeapScenario1) peakHeapScenario1 = memPostTrace.heapUsed
    if (memPostTrace.rss > peakRssScenario1) peakRssScenario1 = memPostTrace.rss

    lagMonitor.disable()
    const singleLagP50 = Math.round((lagMonitor.percentile(50) / 1e6) * 100) / 100
    const singleLagP95 = Math.round((lagMonitor.percentile(95) / 1e6) * 100) / 100
    const singleLagP99 = Math.round((lagMonitor.percentile(99) / 1e6) * 100) / 100
    const singleLagMax = Math.round((lagMonitor.max / 1e6) * 100) / 100
    const singleLagMin = Math.round((lagMonitor.min / 1e6) * 100) / 100
    const singleLagMean = Math.round(((lagMonitor.mean || 0) / 1e6) * 100) / 100

    // Measure synthetic trace payload size
    const sampleTracePayload = {
      traceId: '01a14ebf-1234-7000-8000-000000000001',
      spans: Array.from({ length: tier.limit }, (_, i) => ({
        spanId: `span-${i}`,
        name: i === 0 ? 'http.server.request' : `db.query.item_${i % 10}`,
        kind: i === 0 ? 'server' : 'client',
        durationMs: 1.5,
        attributes: {
          'db.system': 'postgresql',
          'db.statement': `SELECT * FROM items WHERE id = ${i}`,
          'span.index': i,
        },
      })),
    }
    const rawJsonBuffer = Buffer.from(JSON.stringify(sampleTracePayload), 'utf8')
    const gzipBuffer = gzipSync(rawJsonBuffer)
    const compressionRatio = Math.round((1 - gzipBuffer.length / rawJsonBuffer.length) * 100)

    // -------------------------------------------------------------
    // SCENARIO 2: Concurrent Multi-Trace Load (10 concurrent requests)
    // -------------------------------------------------------------
    console.log(`  -> [Scenario 2] Executing concurrent load (10 concurrent traces x ${tier.limit} spans = ${10 * tier.limit} spans)...`)
    lagMonitor.reset()
    lagMonitor.enable()

    let concurrentPeakHeap = 0
    let concurrentPeakRss = 0
    const gcBeforeConcurrent = gcCount
    const gcTimeBeforeConcurrent = gcTotalMs

    const concurrentT0 = performance.now()
    const concurrentWorkers = 10
    const concurrencyPromises: Promise<void>[] = []

    for (let c = 0; c < concurrentWorkers; c++) {
      concurrencyPromises.push(
        (async () => {
          await withSpan(`concurrent.request.${c}`, async reqSpan => {
            reqSpan.setAttribute('client.concurrency_id', c)

            for (let s = 0; s < tier.limit - 1; s++) {
              const child = startSpan(`concurrent.child.${s % 5}`)
              child.setAttribute('child.idx', s)
              child.end()

              if (s % 500 === 0) {
                await new Promise<void>(resolve => setImmediate(resolve))
                const m = process.memoryUsage()
                if (m.heapUsed > concurrentPeakHeap) concurrentPeakHeap = m.heapUsed
                if (m.rss > concurrentPeakRss) concurrentPeakRss = m.rss
              }
            }
          })
        })()
      )
    }

    await Promise.all(concurrencyPromises)
    const concurrentDurationMs = performance.now() - concurrentT0
    lagMonitor.disable()

    const concurrentLagP99 = Math.round((lagMonitor.percentile(99) / 1e6) * 100) / 100
    const totalConcurrentSpans = concurrentWorkers * tier.limit
    const throughputSpansPerSec = Math.round((totalConcurrentSpans / (concurrentDurationMs / 1000)))

    // -------------------------------------------------------------
    // SCENARIO 3: Boundary & Overflow Enforcement (+20% spans)
    // -------------------------------------------------------------
    console.log(`  -> [Scenario 3] Testing overflow boundary (+20% spans = ${Math.round(tier.limit * 1.2)} spans)...`)
    const blockedBefore = costGovernor.getStats().totalSpansBlocked
    const totalToAttempt = Math.round(tier.limit * 1.2)

    await withSpan('overflow.test.root', async overflowRoot => {
      for (let o = 1; o < totalToAttempt; o++) {
        const child = startSpan(`overflow.child.${o}`)
        child.end()
      }
    })

    // Flush pending spans before shutdown resets singletons
    const { flush } = await import('../../src/core/lifecycle.js')
    await flush()

    const blockedAfter = costGovernor.getStats().totalSpansBlocked
    const blockedCount = blockedAfter - blockedBefore
    const admittedCount = totalToAttempt - blockedCount

    await shutdown(3_000)

    if (typeof global.gc === 'function') {
      global.gc()
      global.gc()
    }

    const memFinal = process.memoryUsage()
    gcObserver.disconnect()

    const netHeapGrowth = Math.max(0, memFinal.heapUsed - memInitial.heapUsed)

    const tierResult: TierBenchmarkResult = {
      tierName: tier.name,
      maxSpansPerTrace: tier.limit,
      singleTrace: {
        spansGenerated: tier.limit,
        durationMs: Math.round(durationSingleTraceMs * 100) / 100,
        avgLatencyPerSpanUs: Math.round(((durationSingleTraceMs * 1000) / tier.limit) * 100) / 100,
        opsPerSec: Math.round(tier.limit / (durationSingleTraceMs / 1000)),
        eventLoopLag: {
          minMs: singleLagMin,
          meanMs: singleLagMean,
          p50Ms: singleLagP50,
          p95Ms: singleLagP95,
          p99Ms: singleLagP99,
          maxMs: singleLagMax,
        },
        memory: {
          initialHeapMb: toMb(memInitial.heapUsed),
          peakHeapMb: toMb(peakHeapScenario1),
          postTraceHeapMb: toMb(memPostTrace.heapUsed),
          postGcHeapMb: toMb(memFinal.heapUsed),
          netHeapGrowthMb: toMb(netHeapGrowth),
          initialRssMb: toMb(memInitial.rss),
          peakRssMb: toMb(peakRssScenario1),
          finalRssMb: toMb(memFinal.rss),
        },
        gc: {
          count: gcCount,
          totalDurationMs: Math.round(gcTotalMs * 100) / 100,
          maxDurationMs: Math.round(gcMaxMs * 100) / 100,
          avgDurationMs: gcCount > 0 ? Math.round((gcTotalMs / gcCount) * 100) / 100 : 0,
        },
        wirePayload: {
          rawBytes: rawJsonBuffer.length,
          rawKb: Math.round((rawJsonBuffer.length / 1024) * 10) / 10,
          wireGzipBytes: gzipBuffer.length,
          wireGzipKb: Math.round((gzipBuffer.length / 1024) * 10) / 10,
          compressionRatioPercent: compressionRatio,
        },
      },
      concurrentLoad: {
        concurrency: concurrentWorkers,
        totalSpans: totalConcurrentSpans,
        durationMs: Math.round(concurrentDurationMs * 100) / 100,
        throughputSpansPerSec,
        eventLoopLagP99Ms: concurrentLagP99,
        peakHeapMb: toMb(concurrentPeakHeap),
        peakRssMb: toMb(concurrentPeakRss),
        gcPauseCount: gcCount - gcBeforeConcurrent,
        gcTotalDurationMs: Math.round((gcTotalMs - gcTimeBeforeConcurrent) * 100) / 100,
      },
      overflowEnforcement: {
        attemptedSpans: totalToAttempt,
        admittedSpans: admittedCount,
        blockedSpans: blockedCount,
        enforcementSuccess: admittedCount <= tier.limit,
      },
    }

    results.push(tierResult)
  }

  await mockServer.close()

  const outputPath = join(process.cwd(), 'span-tier-benchmark-results.json')
  await writeFile(outputPath, JSON.stringify(results, null, 2), 'utf8')
  console.log(`\nBenchmark results successfully persisted to: ${outputPath}`)

  return results
}

async function main() {
  console.log('='.repeat(80))
  console.log('   PULSE APM SDK — MULTI-TIER MAX SPANS LOAD & MEMORY BENCHMARK')
  console.log('   Tiers: 500, 1,000, 1,500, 2,000, 5,000 Spans per Trace')
  console.log('='.repeat(80))

  const results = await runSpanTierBenchmark()

  console.log('\n' + '='.repeat(100))
  console.log('                      SPAN TIER BENCHMARK SUMMARY (SINGLE TRACE)')
  console.log('='.repeat(100))

  console.table(
    results.map(r => ({
      Tier: r.tierName,
      Limit: r.maxSpansPerTrace,
      'Time (ms)': r.singleTrace.durationMs,
      'Span (µs)': r.singleTrace.avgLatencyPerSpanUs,
      'Ops / Sec': r.singleTrace.opsPerSec.toLocaleString(),
      'Lag p99 (ms)': r.singleTrace.eventLoopLag.p99Ms,
      'Lag Max (ms)': r.singleTrace.eventLoopLag.maxMs,
      'Peak Heap': `${r.singleTrace.memory.peakHeapMb} MB`,
      'Post-GC Heap': `${r.singleTrace.memory.postGcHeapMb} MB`,
      'Net Heap Δ': `${r.singleTrace.memory.netHeapGrowthMb} MB`,
      'GC Count': r.singleTrace.gc.count,
      'GC Total': `${r.singleTrace.gc.totalDurationMs} ms`,
      'Raw Size': `${r.singleTrace.wirePayload.rawKb} KB`,
      'Gzip Wire': `${r.singleTrace.wirePayload.wireGzipKb} KB`,
    }))
  )

  console.log('\n' + '='.repeat(100))
  console.log('            SPAN TIER BENCHMARK SUMMARY (10 CONCURRENT TRACES SATURATION)')
  console.log('='.repeat(100))

  console.table(
    results.map(r => ({
      Tier: r.tierName,
      'Total Spans (10x)': r.concurrentLoad.totalSpans.toLocaleString(),
      'Duration (ms)': r.concurrentLoad.durationMs,
      'Throughput (spans/s)': r.concurrentLoad.throughputSpansPerSec.toLocaleString(),
      'Conc Lag p99 (ms)': r.concurrentLoad.eventLoopLagP99Ms,
      'Conc Peak Heap': `${r.concurrentLoad.peakHeapMb} MB`,
      'Conc Peak RSS': `${r.concurrentLoad.peakRssMb} MB`,
      'Conc GC Pauses': r.concurrentLoad.gcPauseCount,
      'Conc GC Duration': `${r.concurrentLoad.gcTotalDurationMs} ms`,
      OverflowBlocked: r.overflowEnforcement.blockedSpans,
      Enforced: r.overflowEnforcement.enforcementSuccess ? 'PASSED' : 'FAILED',
    }))
  )
}

main().catch(err => {
  console.error('Span tier benchmark execution failed:', err)
  process.exit(1)
})
