import http from 'node:http'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { init } from '../dist/core/init.js'
import { shutdown } from '../dist/core/lifecycle.js'
import { startSpan } from '../dist/tracing/tracer.js'
import { captureException } from '../dist/capture/captureException.js'
import { captureMetric, incrementCounter } from '../dist/capture/captureMetric.js'
import { captureMessage } from '../dist/capture/captureMessage.js'
import { addBreadcrumb } from '../dist/core/context.js'
import { persistentStorage } from '../dist/storage/persistent-storage.js'
import { SerializationPool } from '../dist/transport/serialization-pool.js'

function getMem() {
  const m = process.memoryUsage()
  return {
    heapUsedMb: Math.round((m.heapUsed / 1024 / 1024) * 100) / 100,
    heapTotalMb: Math.round((m.heapTotal / 1024 / 1024) * 100) / 100,
    rssMb: Math.round((m.rss / 1024 / 1024) * 100) / 100,
    externalMb: Math.round((m.external / 1024 / 1024) * 100) / 100,
  }
}

function gc() {
  if (typeof global.gc === 'function') {
    global.gc()
    global.gc()
  }
}

import { DEFAULT_REMOTE_CONFIG } from '../dist/constants/defaults.js'

async function createMockServer(mode = '200') {
  let receivedBatches = 0
  let receivedEvents = 0
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      receivedBatches++
      const port = server.address().port
      const localUrl = `http://127.0.0.1:${port}`

      if (req.url === '/v1/init') {
        const routePaths = {
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
          Object.entries(DEFAULT_REMOTE_CONFIG.transport.routes).map(([name, route]) => [
            name,
            { ...route, url: `${localUrl}${routePaths[name]}`, batchSize: 500, flushIntervalMs: 50, timeoutMs: 2000 },
          ])
        )
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          success: true,
          projectId: 'audit-proj',
          environment: 'production',
          release: '1.0.0',
          config: {
            ...DEFAULT_REMOTE_CONFIG,
            sdk: { projectId: 'audit-proj', service: 'audit-svc', environment: 'production', release: '1.0.0' },
            features: {
              ...DEFAULT_REMOTE_CONFIG.features,
              tracing: true,
              requestCapture: true,
              errors: true,
              metrics: true,
              logging: true,
              runtimeMetrics: true,
              eventLoopMonitoring: true,
              gcMonitoring: true,
            },
            sampling: {
              ...DEFAULT_REMOTE_CONFIG.sampling,
              traces: 1,
              requests: 1,
              errors: 1,
              metrics: 1,
              logs: 1,
            },
            transport: { ...DEFAULT_REMOTE_CONFIG.transport, routes },
          }
        }))
        return
      }

      if (mode === '500') {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'Server Error' }))
        return
      }
      if (mode === '429') {
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '2' })
        res.end(JSON.stringify({ error: 'Rate Limited' }))
        return
      }

      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ success: true }))
    })
  })

  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    getReceivedBatches: () => receivedBatches,
    setMode: m => { mode = m },
    close: () => new Promise(r => server.close(r))
  }
}

async function runScenarioAudit() {
  console.log('='.repeat(80))
  console.log('   PULSE APM SDK EMPIRICAL STRESS & RAM UTILIZATION AUDIT')
  console.log('='.repeat(80))
  console.log(`OS: ${os.type()} ${os.release()} (${os.arch()}) | Node: ${process.version}`)
  console.log(`Total System Memory: ${(os.totalmem() / 1024 / 1024 / 1024).toFixed(2)} GB`)
  console.log('='.repeat(80))

  const results = {}

  // 1. BASELINE PROCESS MEMORY
  gc()
  const memBaseline = getMem()
  console.log('\n[Baseline Process Memory - Before SDK Init]')
  console.log(`  Heap Used : ${memBaseline.heapUsedMb} MB`)
  console.log(`  Heap Total: ${memBaseline.heapTotalMb} MB`)
  console.log(`  RSS       : ${memBaseline.rssMb} MB`)
  results.baseline = memBaseline

  // 2. SCENARIO A: HEALTHY BACKEND, NORMAL HIGH-LOAD STREAMING
  console.log('\n[Scenario A: Healthy Backend, Normal Streaming 10,000 Telemetry Events]')
  const serverA = await createMockServer('200')
  process.env['PULSE_ENDPOINT'] = serverA.url

  const lagMonitorA = monitorEventLoopDelay({ resolution: 10 })
  lagMonitorA.enable()

  await init({
    apiKey: 'pv_live_audit_test_key_123456789012345678901234.abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
    initTimeoutMs: 2000,
  })

  const memPostInit = getMem()
  console.log(`  Memory Post-Init: Heap Used: ${memPostInit.heapUsedMb} MB | RSS: ${memPostInit.rssMb} MB`)
  console.log(`  Init Overhead   : +${(memPostInit.heapUsedMb - memBaseline.heapUsedMb).toFixed(2)} MB Heap | +${(memPostInit.rssMb - memBaseline.rssMb).toFixed(2)} MB RSS`)

  let peakHeapA = memPostInit.heapUsedMb
  let peakRssA = memPostInit.rssMb

  const t0 = Date.now()
  for (let i = 0; i < 10000; i++) {
    const span = startSpan(`op.span.${i % 10}`)
    span.setAttribute('index', i)
    span.setAttribute('route', '/api/users/checkout')
    span.end()

    incrementCounter('op.counter', 1, { tag: `t${i % 5}` })

    if (i % 10 === 0) {
      captureMessage(`Soak message ${i}`, 'info', { orderId: `ord-${i}` })
    }
    if (i % 20 === 0) {
      captureException(new Error(`Test error ${i}`))
    }

    if (i % 1000 === 0) {
      const m = getMem()
      if (m.heapUsedMb > peakHeapA) peakHeapA = m.heapUsedMb
      if (m.rssMb > peakRssA) peakRssA = m.rssMb
      await new Promise(r => setImmediate(r))
    }
  }

  // Allow transport batches to drain
  await new Promise(r => setTimeout(r, 1500))
  const durationA = Date.now() - t0
  lagMonitorA.disable()

  const memAfterA = getMem()
  await shutdown(3000)
  await serverA.close()
  gc()
  const memPostShutdownA = getMem()

  console.log(`  Events Ingested : 10,000 ops in ${durationA} ms (~${Math.round(10000 / (durationA / 1000))} ops/sec)`)
  console.log(`  Peak Heap Used  : ${peakHeapA} MB (Peak Delta: +${(peakHeapA - memBaseline.heapUsedMb).toFixed(2)} MB)`)
  console.log(`  Peak RSS        : ${peakRssA} MB (Peak Delta: +${(peakRssA - memBaseline.rssMb).toFixed(2)} MB)`)
  console.log(`  Event Loop Lag  : p50=${(lagMonitorA.percentile(50) / 1e6).toFixed(2)}ms | p95=${(lagMonitorA.percentile(95) / 1e6).toFixed(2)}ms | p99=${(lagMonitorA.percentile(99) / 1e6).toFixed(2)}ms | max=${(lagMonitorA.max / 1e6).toFixed(2)}ms`)
  console.log(`  Post-Shutdown GC: Heap Used: ${memPostShutdownA.heapUsedMb} MB | Retained Delta: +${(memPostShutdownA.heapUsedMb - memBaseline.heapUsedMb).toFixed(2)} MB`)

  results.scenarioA = {
    peakHeapMb: peakHeapA,
    peakRssMb: peakRssA,
    heapDeltaMb: peakHeapA - memBaseline.heapUsedMb,
    rssDeltaMb: peakRssA - memBaseline.rssMb,
    retainedHeapMb: memPostShutdownA.heapUsedMb - memBaseline.heapUsedMb,
    lagP99Ms: lagMonitorA.percentile(99) / 1e6,
    lagMaxMs: lagMonitorA.max / 1e6,
  }

  // 3. SCENARIO B: NETWORK OUTAGE (BACKEND DOWN / ECONNREFUSED)
  console.log('\n[Scenario B: Network Outage - Backend Completely Unreachable (ECONNREFUSED)]')
  gc()
  const memBeforeB = getMem()

  // Use dead port
  process.env['PULSE_ENDPOINT'] = 'http://127.0.0.1:49999'

  const lagMonitorB = monitorEventLoopDelay({ resolution: 10 })
  lagMonitorB.enable()

  await init({
    apiKey: 'pv_live_audit_test_key_123456789012345678901234.abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
    initTimeoutMs: 500,
  })

  let peakHeapB = getMem().heapUsedMb
  let peakRssB = getMem().rssMb

  console.log('  Flooding 10,000 events into offline queue...')
  for (let i = 0; i < 10000; i++) {
    const span = startSpan(`offline.span.${i % 5}`)
    span.setAttribute('test', 'offline_queue')
    span.end()

    if (i % 5 === 0) {
      incrementCounter('offline.counter', 1)
    }
    if (i % 10 === 0) {
      captureException(new Error(`Offline error ${i}`))
    }

    if (i % 500 === 0) {
      const m = getMem()
      if (m.heapUsedMb > peakHeapB) peakHeapB = m.heapUsedMb
      if (m.rssMb > peakRssB) peakRssB = m.rssMb
      await new Promise(r => setImmediate(r))
    }
  }

  // Wait for retry attempts & persistence writes
  await new Promise(r => setTimeout(r, 2000))
  const mEndB = getMem()
  if (mEndB.heapUsedMb > peakHeapB) peakHeapB = mEndB.heapUsedMb
  if (mEndB.rssMb > peakRssB) peakRssB = mEndB.rssMb

  lagMonitorB.disable()

  console.log(`  Peak Heap During Outage: ${peakHeapB} MB (Delta: +${(peakHeapB - memBeforeB.heapUsedMb).toFixed(2)} MB)`)
  console.log(`  Peak RSS During Outage : ${peakRssB} MB (Delta: +${(peakRssB - memBeforeB.rssMb).toFixed(2)} MB)`)
  console.log(`  Event Loop Lag Outage  : p50=${(lagMonitorB.percentile(50) / 1e6).toFixed(2)}ms | p99=${(lagMonitorB.percentile(99) / 1e6).toFixed(2)}ms | max=${(lagMonitorB.max / 1e6).toFixed(2)}ms`)

  const offlineDataFile = persistentStorage.dataFilePath
  let offlineDiskBytes = 0
  try {
    const s = await fs.stat(offlineDataFile)
    offlineDiskBytes = s.size
    console.log(`  Offline NDJSON Disk Size: ${(offlineDiskBytes / 1024).toFixed(2)} KB (${offlineDataFile})`)
  } catch {
    console.log(`  Offline file stat: No file written or not yet flushed`)
  }

  await shutdown(3000)
  gc()
  const memPostShutdownB = getMem()

  results.scenarioB = {
    peakHeapMb: peakHeapB,
    peakRssMb: peakRssB,
    heapDeltaMb: peakHeapB - memBeforeB.heapUsedMb,
    rssDeltaMb: peakRssB - memBeforeB.rssMb,
    retainedHeapMb: memPostShutdownB.heapUsedMb - memBeforeB.heapUsedMb,
    offlineDiskBytes,
    lagP99Ms: lagMonitorB.percentile(99) / 1e6,
    lagMaxMs: lagMonitorB.max / 1e6,
  }

  // 4. SCENARIO C: TRANSIENT SERVER ERRORS (HTTP 500 & HTTP 429 RATE LIMITING)
  console.log('\n[Scenario C: Backend Errors - HTTP 500 & HTTP 429 (Backoff Timers & Quota Retries)]')
  const serverC = await createMockServer('500')
  process.env['PULSE_ENDPOINT'] = serverC.url
  gc()
  const memBeforeC = getMem()

  const lagMonitorC = monitorEventLoopDelay({ resolution: 10 })
  lagMonitorC.enable()

  await init({
    apiKey: 'pv_live_audit_test_key_123456789012345678901234.abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
    initTimeoutMs: 1500,
  })

  let peakHeapC = getMem().heapUsedMb
  let peakRssC = getMem().rssMb

  console.log('  Streaming 5,000 events against 500/429 server...')
  for (let i = 0; i < 5000; i++) {
    if (i === 2500) {
      serverC.setMode('429') // switch to rate limited
    }
    const span = startSpan(`err.span.${i % 5}`)
    span.end()

    if (i % 5 === 0) captureException(new Error(`Err ${i}`))

    if (i % 500 === 0) {
      const m = getMem()
      if (m.heapUsedMb > peakHeapC) peakHeapC = m.heapUsedMb
      if (m.rssMb > peakRssC) peakRssC = m.rssMb
      await new Promise(r => setImmediate(r))
    }
  }

  await new Promise(r => setTimeout(r, 2000))
  const mEndC = getMem()
  if (mEndC.heapUsedMb > peakHeapC) peakHeapC = mEndC.heapUsedMb
  if (mEndC.rssMb > peakRssC) peakRssC = mEndC.rssMb

  lagMonitorC.disable()
  await shutdown(3000)
  await serverC.close()
  gc()

  console.log(`  Peak Heap Under 500/429: ${peakHeapC} MB (Delta: +${(peakHeapC - memBeforeC.heapUsedMb).toFixed(2)} MB)`)
  console.log(`  Peak RSS Under 500/429 : ${peakRssC} MB (Delta: +${(peakRssC - memBeforeC.rssMb).toFixed(2)} MB)`)
  console.log(`  Event Loop Lag 500/429 : p50=${(lagMonitorC.percentile(50) / 1e6).toFixed(2)}ms | p99=${(lagMonitorC.percentile(99) / 1e6).toFixed(2)}ms | max=${(lagMonitorC.max / 1e6).toFixed(2)}ms`)

  results.scenarioC = {
    peakHeapMb: peakHeapC,
    peakRssMb: peakRssC,
    heapDeltaMb: peakHeapC - memBeforeC.heapUsedMb,
    rssDeltaMb: peakRssC - memBeforeC.rssMb,
    lagP99Ms: lagMonitorC.percentile(99) / 1e6,
    lagMaxMs: lagMonitorC.max / 1e6,
  }

  // 5. SCENARIO D: OFFLINE QUEUE REPLAY & DISCARD COMPACTION MEMORY SPIKE
  console.log('\n[Scenario D: Offline Queue Replay & Compaction Spike]')
  const serverD = await createMockServer('200')
  process.env['PULSE_ENDPOINT'] = serverD.url
  gc()
  const memBeforeD = getMem()

  const lagMonitorD = monitorEventLoopDelay({ resolution: 10 })
  lagMonitorD.enable()

  await init({
    apiKey: 'pv_live_audit_test_key_123456789012345678901234.abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
    initTimeoutMs: 2000,
  })

  const memPostReplayD = getMem()
  console.log(`  Memory Post-Replay Init: Heap: ${memPostReplayD.heapUsedMb} MB | RSS: ${memPostReplayD.rssMb} MB`)

  // Allow replayed events to flush and be discarded/compacted from disk
  await new Promise(r => setTimeout(r, 2000))
  const memPostDiscardD = getMem()
  lagMonitorD.disable()
  await shutdown(3000)
  await serverD.close()
  gc()

  console.log(`  Memory Post-Discard    : Heap: ${memPostDiscardD.heapUsedMb} MB | RSS: ${memPostDiscardD.rssMb} MB`)
  console.log(`  Event Loop Lag Replay  : p99=${(lagMonitorD.percentile(99) / 1e6).toFixed(2)}ms | max=${(lagMonitorD.max / 1e6).toFixed(2)}ms`)

  results.scenarioD = {
    postReplayHeapMb: memPostReplayD.heapUsedMb,
    postDiscardHeapMb: memPostDiscardD.heapUsedMb,
    lagP99Ms: lagMonitorD.percentile(99) / 1e6,
    lagMaxMs: lagMonitorD.max / 1e6,
  }

  // 6. SCENARIO E: HEAVY PAYLOAD & PII SCRUBBER LATENCY / ALLOCATION
  console.log('\n[Scenario E: PII Scrubber & Heavy JSON Deep-Scrubbing Overhead]')
  const serverE = await createMockServer('200')
  process.env['PULSE_ENDPOINT'] = serverE.url
  gc()
  const memBeforeE = getMem()

  await init({
    apiKey: 'pv_live_audit_test_key_123456789012345678901234.abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
    initTimeoutMs: 1500,
  })

  const lagMonitorE = monitorEventLoopDelay({ resolution: 10 })
  lagMonitorE.enable()

  const tStartE = Date.now()
  for (let i = 0; i < 2000; i++) {
    captureMessage(`User checkout transaction with payload`, 'info', {
      user: { email: `customer_${i}@enterprise-corp.com`, phone: '+1-555-839-2910', ip: '192.168.1.105' },
      payment: { cardNumber: '4111-2222-3333-4444', token: 'sk_live_982340918230918230981230' },
      nestedContext: {
        headers: { authorization: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.doNotLeakThisToken' },
        requestData: { query: 'token=secret&user=admin', body: { secretField: 'topSecret123', safeField: 'visible' } }
      }
    })
    if (i % 200 === 0) await new Promise(r => setImmediate(r))
  }

  await new Promise(r => setTimeout(r, 1000))
  const durationE = Date.now() - tStartE
  lagMonitorE.disable()
  const memAfterE = getMem()
  await shutdown(3000)
  await serverE.close()
  gc()

  console.log(`  2,000 Heavy PII Payloads scrubbed in: ${durationE} ms`)
  console.log(`  Heap Peak During Scrubbing: ${memAfterE.heapUsedMb} MB | Delta: +${(memAfterE.heapUsedMb - memBeforeE.heapUsedMb).toFixed(2)} MB`)
  console.log(`  Event Loop Lag Scrubbing  : p50=${(lagMonitorE.percentile(50) / 1e6).toFixed(2)}ms | p99=${(lagMonitorE.percentile(99) / 1e6).toFixed(2)}ms | max=${(lagMonitorE.max / 1e6).toFixed(2)}ms`)

  results.scenarioE = {
    durationMs: durationE,
    heapDeltaMb: memAfterE.heapUsedMb - memBeforeE.heapUsedMb,
    lagP99Ms: lagMonitorE.percentile(99) / 1e6,
    lagMaxMs: lagMonitorE.max / 1e6,
  }

  // 7. FINAL SUMMARY & 1% RAM UTILIZATION MATHEMATICAL COMPARISON
  console.log('\n' + '='.repeat(80))
  console.log('              RAM UTILIZATION VS 1% CLAIM MATHEMATICAL PROOF')
  console.log('='.repeat(80))

  const containerSizes = [
    { name: '512 MB Container (Serverless / Micro)', totalMb: 512, onePercentMb: 5.12 },
    { name: '1 GB Container (Standard Cloud Run / Pod)', totalMb: 1024, onePercentMb: 10.24 },
    { name: '2 GB VM (Medium Backend Service)', totalMb: 2048, onePercentMb: 20.48 },
    { name: '4 GB VM (Large Production Node)', totalMb: 4096, onePercentMb: 40.96 },
    { name: '8 GB Bare Metal / Cloud Server', totalMb: 8192, onePercentMb: 81.92 },
    { name: '16 GB Enterprise Host', totalMb: 16384, onePercentMb: 163.84 },
  ]

  const worstCaseHeapDelta = Math.max(
    results.scenarioA.heapDeltaMb,
    results.scenarioB.heapDeltaMb,
    results.scenarioC.heapDeltaMb
  )
  const worstCaseRssDelta = Math.max(
    results.scenarioA.rssDeltaMb,
    results.scenarioB.rssDeltaMb,
    results.scenarioC.rssDeltaMb
  )

  console.log(`Worst-Case Observed Heap Growth: +${worstCaseHeapDelta.toFixed(2)} MB`)
  console.log(`Worst-Case Observed RSS Growth : +${worstCaseRssDelta.toFixed(2)} MB`)
  console.log('\nEvaluation against "< 1% RAM Utilization" Claim:')

  const tableData = containerSizes.map(c => {
    const heapPercent = ((worstCaseHeapDelta / c.totalMb) * 100).toFixed(2)
    const rssPercent = ((worstCaseRssDelta / c.totalMb) * 100).toFixed(2)
    const heapPass = worstCaseHeapDelta <= c.onePercentMb ? 'PASS' : 'FAIL (EXCEEDS)'
    const rssPass = worstCaseRssDelta <= c.onePercentMb ? 'PASS' : 'FAIL (EXCEEDS)'
    return {
      'Environment': c.name,
      'Total RAM': `${c.totalMb} MB`,
      '1% Budget': `${c.onePercentMb.toFixed(2)} MB`,
      'Heap % of Host': `${heapPercent}%`,
      'Heap Status': heapPass,
      'RSS % of Host': `${rssPercent}%`,
      'RSS Status': rssPass,
    }
  })

  console.table(tableData)

  await fs.writeFile(
    path.join(process.cwd(), 'scratch', 'stress-audit-results.json'),
    JSON.stringify({ results, tableData, timestamp: new Date().toISOString() }, null, 2),
    'utf8'
  )
  console.log('\nAudit raw benchmark data saved to scratch/stress-audit-results.json\n')
}

runScenarioAudit().catch(err => {
  console.error('Audit run failed:', err)
  process.exit(1)
})
