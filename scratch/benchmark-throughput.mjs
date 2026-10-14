import { performance } from 'node:perf_hooks'
import { SerializationPool } from '../dist/transport/serialization-pool.js'
import { TransportRouter } from '../dist/transport/transport-router.js'
import { DEFAULT_TRANSPORT, DEFAULT_TRANSPORT_ROUTES } from '../dist/constants/defaults.js'
import { SAFETY_CEILINGS } from '../dist/constants/limits.js'

function generateMockSpan(id) {
  return {
    eventId: `span-${id}-${Date.now()}`,
    type: 'span',
    timestamp: Date.now(),
    name: 'GET /api/v1/checkout/process',
    traceId: `trace-${id % 1000}-4607-b31c-3298a4`,
    spanId: `span-${id}-3298a4`,
    durationMs: 14.2,
    attributes: {
      'http.method': 'GET',
      'http.status_code': 200,
      'http.url': 'https://api.example.com/v1/checkout/process',
      'user.id': `user-${id % 500}`,
      'db.statement': 'SELECT * FROM orders WHERE user_id = $1 AND status = active',
      'service.version': '8.5.0',
    },
  }
}

function generateMockMetric(id) {
  return {
    eventId: `metric-${id}-${Date.now()}`,
    type: 'metric',
    timestamp: Date.now(),
    name: 'http.server.requests',
    value: 1,
    unit: 'count',
    attributes: {
      route: '/api/v1/checkout/process',
      method: 'GET',
      code: '200',
    },
  }
}

async function runSerializationBenchmark() {
  console.log('===============================================================')
  console.log('   PULSE APM SDK — SERIALIZATION POOL & INGESTION BENCHMARK   ')
  console.log('===============================================================')

  SerializationPool.initialize(1)
  const pool = SerializationPool.getInstance()

  // -------------------------------------------------------------------------
  // Test 1: Small Batches (< 50KB, Main-Thread Fast Path via libuv)
  // -------------------------------------------------------------------------
  console.log('\n--- 1. Small Batches (< 50KB): Main-Thread Fast Path via libuv ---')
  const smallBatchSize = 40 // ~20KB uncompressed
  const smallBatchCount = 500 // 20,000 total events
  const smallBatches = []
  for (let b = 0; b < smallBatchCount; b++) {
    const events = []
    for (let i = 0; i < smallBatchSize; i++) {
      events.push(generateMockSpan(b * smallBatchSize + i))
    }
    smallBatches.push(events)
  }

  // Measure event loop lag during execution
  let maxSmallLag = 0
  const lagInterval = setInterval(() => {
    const start = performance.now()
    setImmediate(() => {
      const lag = performance.now() - start
      if (lag > maxSmallLag) maxSmallLag = lag
    })
  }, 10)

  const startSmall = performance.now()
  let totalSmallBytes = 0
  for (const batch of smallBatches) {
    const res = await pool.serializeBatch({
      events: batch,
      route: 'spans',
      compression: 'gzip',
    })
    totalSmallBytes += res.originalSize
  }
  const endSmall = performance.now()
  clearInterval(lagInterval)

  const smallDurationSec = (endSmall - startSmall) / 1000
  const smallTotalEvents = smallBatchSize * smallBatchCount
  const smallEventsPerSec = smallTotalEvents / smallDurationSec
  const smallMBPerSec = (totalSmallBytes / (1024 * 1024)) / smallDurationSec

  console.log(`Events Processed:    ${smallTotalEvents.toLocaleString()} spans`)
  console.log(`Batches Processed:   ${smallBatchCount} batches (${smallBatchSize} events/batch)`)
  console.log(`Duration:            ${(endSmall - startSmall).toFixed(2)} ms`)
  console.log(`Throughput:          ${Math.round(smallEventsPerSec).toLocaleString()} events/sec`)
  console.log(`Data Throughput:     ${smallMBPerSec.toFixed(2)} MB/sec (uncompressed)`)
  console.log(`Peak Event Loop Lag: ${maxSmallLag.toFixed(2)} ms`)

  // -------------------------------------------------------------------------
  // Test 2: Large Batches (> 50KB, Background Worker Thread Offload)
  // -------------------------------------------------------------------------
  console.log('\n--- 2. Large Batches (> 50KB): Background Worker Thread Offload ---')
  const largeBatchSize = 500 // ~250KB uncompressed (> 50KB threshold)
  const largeBatchCount = 50 // 25,000 total events
  const largeBatches = []
  for (let b = 0; b < largeBatchCount; b++) {
    const events = []
    for (let i = 0; i < largeBatchSize; i++) {
      events.push(generateMockSpan(b * largeBatchSize + i))
    }
    largeBatches.push(events)
  }

  let maxLargeLag = 0
  const lagIntervalLarge = setInterval(() => {
    const start = performance.now()
    setImmediate(() => {
      const lag = performance.now() - start
      if (lag > maxLargeLag) maxLargeLag = lag
    })
  }, 10)

  const startLarge = performance.now()
  let totalLargeBytes = 0
  for (const batch of largeBatches) {
    const res = await pool.serializeBatch({
      events: batch,
      route: 'spans',
      compression: 'gzip',
    })
    totalLargeBytes += res.originalSize
  }
  const endLarge = performance.now()
  clearInterval(lagIntervalLarge)

  const largeDurationSec = (endLarge - startLarge) / 1000
  const largeTotalEvents = largeBatchSize * largeBatchCount
  const largeEventsPerSec = largeTotalEvents / largeDurationSec
  const largeMBPerSec = (totalLargeBytes / (1024 * 1024)) / largeDurationSec

  console.log(`Events Processed:    ${largeTotalEvents.toLocaleString()} spans`)
  console.log(`Batches Processed:   ${largeBatchCount} batches (${largeBatchSize} events/batch)`)
  console.log(`Duration:            ${(endLarge - startLarge).toFixed(2)} ms`)
  console.log(`Throughput:          ${Math.round(largeEventsPerSec).toLocaleString()} events/sec`)
  console.log(`Data Throughput:     ${largeMBPerSec.toFixed(2)} MB/sec (uncompressed)`)
  console.log(`Peak Event Loop Lag: ${maxLargeLag.toFixed(2)} ms`)

  // -------------------------------------------------------------------------
  // Test 3: Metric Events Ingestion & Serialization (High-Density)
  // -------------------------------------------------------------------------
  console.log('\n--- 3. Metric Events (1,000 events/batch, ~80KB uncompressed) ---')
  const metricBatchSize = 1000
  const metricBatchCount = 30 // 30,000 metrics
  const metricBatches = []
  for (let b = 0; b < metricBatchCount; b++) {
    const events = []
    for (let i = 0; i < metricBatchSize; i++) {
      events.push(generateMockMetric(b * metricBatchSize + i))
    }
    metricBatches.push(events)
  }

  const startMetric = performance.now()
  let totalMetricBytes = 0
  for (const batch of metricBatches) {
    const res = await pool.serializeBatch({
      events: batch,
      route: 'metrics',
      compression: 'gzip',
    })
    totalMetricBytes += res.originalSize
  }
  const endMetric = performance.now()
  const metricDurationSec = (endMetric - startMetric) / 1000
  const metricTotalEvents = metricBatchSize * metricBatchCount
  const metricEventsPerSec = metricTotalEvents / metricDurationSec

  console.log(`Metrics Processed:   ${metricTotalEvents.toLocaleString()} metrics`)
  console.log(`Batches Processed:   ${metricBatchCount} batches (${metricBatchSize} events/batch)`)
  console.log(`Throughput:          ${Math.round(metricEventsPerSec).toLocaleString()} metrics/sec`)

  // -------------------------------------------------------------------------
  // Test 4: End-to-End TransportRouter Ingestion at Scale (50,000 Events)
  // -------------------------------------------------------------------------
  console.log('\n--- 4. End-to-End TransportRouter Ingestion Throughput ---')
  let dispatchedBatches = 0
  let totalDispatchedBytes = 0
  const mockFetch = async (url, init) => {
    dispatchedBatches++
    if (init?.body) {
      const len = init.body.byteLength ?? init.body.length ?? 0
      totalDispatchedBytes += len
    }
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const routerConfig = {
    ...DEFAULT_TRANSPORT,
    routes: {
      ...DEFAULT_TRANSPORT_ROUTES,
      spans: {
        url: 'https://127.0.0.1/v1/spans',
        batchSize: 500,
        flushIntervalMs: 5000,
        timeoutMs: 5000,
        compression: 'gzip',
        priority: 'high',
      },
    },
  }

  const limitsConfig = {
    maxPayloadSize: SAFETY_CEILINGS.maxPayloadSize,
    maxSpansPerTrace: SAFETY_CEILINGS.maxSpansPerTrace,
    maxSpanAttributes: SAFETY_CEILINGS.maxSpanAttributes,
    maxAttributeLength: SAFETY_CEILINGS.maxAttributeLength,
    maxMemoryMb: SAFETY_CEILINGS.maxMemoryMb,
  }

  const router = await TransportRouter.initialize(
    routerConfig,
    'pulse_test_key_1234567890abcdef',
    mockFetch,
    limitsConfig,
  )

  const TOTAL_EVENTS = 50_000
  const memBefore = process.memoryUsage()
  const startIngest = performance.now()

  for (let i = 0; i < TOTAL_EVENTS; i++) {
    router.send(generateMockSpan(i))
  }

  const ingestDuration = performance.now() - startIngest
  const ingestRPS = TOTAL_EVENTS / (ingestDuration / 1000)

  console.log(`Ingested:            ${TOTAL_EVENTS.toLocaleString()} events into TransportRouter`)
  console.log(`Ingestion Duration:  ${ingestDuration.toFixed(2)} ms`)
  console.log(`Ingestion Rate:      ${Math.round(ingestRPS).toLocaleString()} events/sec`)

  // Flush to network
  const startDrain = performance.now()
  await router.flushAll()
  const drainDuration = performance.now() - startDrain
  const memAfter = process.memoryUsage()

  console.log(`Drain Duration:      ${drainDuration.toFixed(2)} ms`)
  console.log(`Batches Sent:        ${dispatchedBatches} HTTP batches`)
  console.log(`Avg Batch Size:      ${(TOTAL_EVENTS / dispatchedBatches).toFixed(1)} events/batch`)
  console.log(`Total Wire Bytes:    ${(totalDispatchedBytes / 1024).toFixed(2)} KB (gzip compressed)`)
  console.log(`Avg Wire Body:       ${(totalDispatchedBytes / dispatchedBatches / 1024).toFixed(2)} KB/batch`)
  console.log(`Heap Diff:           ${((memAfter.heapUsed - memBefore.heapUsed) / 1024 / 1024).toFixed(2)} MB`)
  console.log(`RSS Diff:            ${((memAfter.rss - memBefore.rss) / 1024 / 1024).toFixed(2)} MB`)

  await router.shutdown()
  await pool.shutdown()
  console.log('\n===============================================================')
  console.log('                   BENCHMARK COMPLETED SUCCESSFULLY            ')
  console.log('===============================================================')
}

runSerializationBenchmark().catch(console.error)
