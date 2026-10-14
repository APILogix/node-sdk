import http from 'node:http'
import axios from 'axios'
import { performance } from 'node:perf_hooks'

// Start a fast local mock HTTP server
const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', chunk => { body += chunk })
  req.on('end', () => {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'X-Response-Time': '0.1ms'
    })
    res.end(JSON.stringify({ status: 'ok', receivedBytes: body.length }))
  })
})

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const url = `http://127.0.0.1:${port}/telemetry`

const payload = JSON.stringify({
  events: Array.from({ length: 10 }, (_, i) => ({
    id: `evt-${i}`,
    type: 'span',
    name: 'HTTP GET /api/v1/users',
    timestamp: Date.now(),
    durationMs: 42.5,
    attributes: { 'http.status_code': 200, 'service.name': 'user-service' }
  }))
})

// Configure keep-alive agent for axios to ensure fair comparison
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 100 })
const axiosInstance = axios.create({
  httpAgent,
  headers: { 'Content-Type': 'application/json' }
})

// Warm up both clients
for (let i = 0; i < 50; i++) {
  await fetch(url, { method: 'POST', body: payload, headers: { 'Content-Type': 'application/json' } })
  await axiosInstance.post(url, payload)
}

const WARMUP_COUNT = 100
const BENCHMARK_COUNT = 2000
const CONCURRENCY = 20

async function runBenchmark(name, fn) {
  // Force GC if available
  if (global.gc) global.gc()
  const memBefore = process.memoryUsage()
  const startCpu = process.cpuUsage()
  const latencies = []
  const start = performance.now()

  let inFlight = 0
  let index = 0

  await new Promise((resolve, reject) => {
    function next() {
      while (inFlight < CONCURRENCY && index < BENCHMARK_COUNT) {
        const currentIndex = index++
        inFlight++
        const reqStart = performance.now()
        fn()
          .then(() => {
            latencies.push(performance.now() - reqStart)
            inFlight--
            if (index < BENCHMARK_COUNT) {
              next()
            } else if (inFlight === 0) {
              resolve()
            }
          })
          .catch(reject)
      }
    }
    next()
  })

  const totalTimeMs = performance.now() - start
  const endCpu = process.cpuUsage(startCpu)
  const memAfter = process.memoryUsage()

  latencies.sort((a, b) => a - b)
  const p50 = latencies[Math.floor(latencies.length * 0.50)]
  const p90 = latencies[Math.floor(latencies.length * 0.90)]
  const p95 = latencies[Math.floor(latencies.length * 0.95)]
  const p99 = latencies[Math.floor(latencies.length * 0.99)]
  const min = latencies[0]
  const max = latencies[latencies.length - 1]
  const rps = (BENCHMARK_COUNT / (totalTimeMs / 1000))

  return {
    name,
    requests: BENCHMARK_COUNT,
    concurrency: CONCURRENCY,
    totalTimeMs: totalTimeMs.toFixed(2),
    rps: Math.round(rps),
    latency: {
      min: min.toFixed(2),
      p50: p50.toFixed(2),
      p90: p90.toFixed(2),
      p95: p95.toFixed(2),
      p99: p99.toFixed(2),
      max: max.toFixed(2),
    },
    cpuUserMs: (endCpu.user / 1000).toFixed(2),
    cpuSystemMs: (endCpu.system / 1000).toFixed(2),
    heapUsedDeltaMb: ((memAfter.heapUsed - memBefore.heapUsed) / (1024 * 1024)).toFixed(2)
  }
}

console.log('Running Native Fetch benchmark...')
const fetchResults = await runBenchmark('Native fetch (Undici/Node.js)', async () => {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload
  })
  await res.json()
})

console.log('Running Axios benchmark...')
const axiosResults = await runBenchmark('Axios (Node.js http.Agent)', async () => {
  const res = await axiosInstance.post(url, payload)
  return res.data
})

server.close()

console.log('\n=== BENCHMARK RESULTS ===')
console.log(JSON.stringify({ fetchResults, axiosResults }, null, 2))
