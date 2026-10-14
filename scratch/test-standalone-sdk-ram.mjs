import http from 'http'
import { monitorEventLoopDelay } from 'perf_hooks'
import { init, startSpan, shutdown } from '../dist/index.js'
import { DEFAULT_REMOTE_CONFIG } from '../dist/constants/defaults.js'

function getMem() {
  const m = process.memoryUsage()
  return {
    heapUsedMb: +(m.heapUsed / 1024 / 1024).toFixed(2),
    heapTotalMb: +(m.heapTotal / 1024 / 1024).toFixed(2),
    rssMb: +(m.rss / 1024 / 1024).toFixed(2),
  }
}

async function run() {
  let serverPort = 0
  const server = http.createServer((req, res) => {
    if (req.url === '/v1/init') {
      const localUrl = `http://127.0.0.1:${serverPort}`
      const routes = Object.fromEntries(
        Object.entries(DEFAULT_REMOTE_CONFIG.transport.routes).map(([name, route]) => [
          name,
          { ...route, url: `${localUrl}/api/v1/${name}`, batchSize: 500, flushIntervalMs: 50, timeoutMs: 2000 },
        ])
      )
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        success: true,
        projectId: 'standalone-app',
        environment: 'production',
        release: '1.0.0',
        config: {
          ...DEFAULT_REMOTE_CONFIG,
          sdk: { projectId: 'standalone-app', service: 'web-service', environment: 'production', release: '1.0.0' },
          features: {
            ...DEFAULT_REMOTE_CONFIG.features,
            tracing: true,
            requestCapture: true,
            errors: true,
            metrics: true,
            logging: true,
            profiling: false,
          },
          sampling: { ...DEFAULT_REMOTE_CONFIG.sampling, traces: 1, requests: 1, errors: 1 },
          transport: { ...DEFAULT_REMOTE_CONFIG.transport, routes },
        }
      }))
      return
    }

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ accepted: 100 }))
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  serverPort = server.address().port
  process.env['PULSE_ENDPOINT'] = `http://127.0.0.1:${serverPort}`

  if (global.gc) global.gc()
  const baseline = getMem()
  console.log(`Baseline (Host App): Heap Used = ${baseline.heapUsedMb} MB | RSS = ${baseline.rssMb} MB`)

  const lagMonitor = monitorEventLoopDelay({ resolution: 10 })
  lagMonitor.enable()

  await init({
    apiKey: 'pv_live_test_123456789012345678901234.abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
    initTimeoutMs: 1500,
  })

  const postInit = getMem()
  console.log(`Post-Init SDK Overhead: Heap = +${(postInit.heapUsedMb - baseline.heapUsedMb).toFixed(2)} MB | RSS = +${(postInit.rssMb - baseline.rssMb).toFixed(2)} MB`)

  console.log('Sending 10,000 spans...')
  for (let i = 0; i < 10000; i++) {
    const span = startSpan(`op.span.${i % 10}`)
    span.setAttribute('id', i)
    span.end()
    if (i % 500 === 0) await new Promise(r => setImmediate(r))
  }

  await new Promise(r => setTimeout(r, 1000))
  if (global.gc) global.gc()
  const activeMem = getMem()
  lagMonitor.disable()

  console.log(`Streaming Steady-State Overhead: Heap = +${(activeMem.heapUsedMb - baseline.heapUsedMb).toFixed(2)} MB | RSS = +${(activeMem.rssMb - baseline.rssMb).toFixed(2)} MB`)
  console.log(`Event Loop Lag: p50 = ${(lagMonitor.percentile(50) / 1e6).toFixed(2)}ms | p99 = ${(lagMonitor.percentile(99) / 1e6).toFixed(2)}ms | max = ${(lagMonitor.max / 1e6).toFixed(2)}ms`)

  await shutdown(2000)
  await new Promise(r => server.close(r))
  if (global.gc) global.gc()
  const postShutdown = getMem()
  console.log(`Post-Shutdown Retained: Heap = +${(postShutdown.heapUsedMb - baseline.heapUsedMb).toFixed(2)} MB | RSS = +${(postShutdown.rssMb - baseline.rssMb).toFixed(2)} MB`)
}

run().catch(console.error)
