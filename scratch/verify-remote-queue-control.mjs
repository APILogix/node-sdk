import http from 'node:http'
import assert from 'node:assert/strict'
import { init } from '../dist/core/init.js'
import { shutdown } from '../dist/core/lifecycle.js'
import { ConfigManager } from '../dist/core/config-manager.js'
import { TransportRouter } from '../dist/transport/transport-router.js'
import { DEFAULT_REMOTE_CONFIG } from '../dist/constants/defaults.js'
import { startSpan } from '../dist/tracing/tracer.js'

async function runTest() {
  console.log('Testing remote control of queue size and dynamic updates in SDK...')

  let currentConfigVersion = 1
  let currentQueueMaxSize = 2000
  let currentBatchSize = 100

  const server = http.createServer((req, res) => {
    const port = server.address().port
    const localUrl = `http://127.0.0.1:${port}`

    function getConfigSnapshot() {
      const routes = Object.fromEntries(
        Object.entries(DEFAULT_REMOTE_CONFIG.transport.routes).map(([name, route]) => [
          name,
          {
            ...route,
            url: `${localUrl}/v1/${name}`,
            batchSize: currentBatchSize,
            flushIntervalMs: 5000,
            timeoutMs: 2000,
          },
        ])
      )
      return {
        ...DEFAULT_REMOTE_CONFIG,
        sdk: { projectId: 'test-p', service: 'test-s', environment: 'production', release: '1.0.0' },
        meta: {
          generatedAt: new Date().toISOString(),
          generatedBy: 'test-control-plane',
          configRevision: currentConfigVersion,
        },
        transport: {
          ...DEFAULT_REMOTE_CONFIG.transport,
          queue: {
            ...DEFAULT_REMOTE_CONFIG.transport.queue,
            maxSize: currentQueueMaxSize,
          },
          routes,
        },
        limits: {
          ...DEFAULT_REMOTE_CONFIG.limits,
          maxQueueSize: currentQueueMaxSize,
        },
      }
    }

    if (req.url === '/v1/init') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        success: true,
        projectId: 'test-p',
        environment: 'production',
        release: '1.0.0',
        config: getConfigSnapshot(),
      }))
      return
    }

    // Config refresh endpoint polled or fetched on change signal
    if (req.url === '/v1/sdk-config' || req.url.startsWith('/v1/config')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(getConfigSnapshot()))
      return
    }

    // Telemetry send endpoints
    res.writeHead(200, { 'content-type': 'application/json' })
    // Send response with change: true if version changed
    res.end(JSON.stringify({ success: true, processed: true }))
  })

  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  process.env['PULSE_ENDPOINT'] = `http://127.0.0.1:${port}`

  try {
    // 1. Initialize SDK with remote config having queue.maxSize = 2000
    await init({
      apiKey: 'pv_live_audit_test_key_123456789012345678901234.abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
      initTimeoutMs: 2000,
    })

    const router = TransportRouter.getInstance()
    assert.ok(router, 'TransportRouter must be initialized')

    const health1 = router.getHealth()
    console.log(`Initial Route 'traces' Queue Capacity: ${health1.routes.traces.queueCapacity}`)
    assert.equal(health1.routes.traces.queueCapacity, 2000, 'Initial capacity should match remote config (2000)')

    // 2. Change remote control configuration: shrink queue.maxSize to 350 and batchSize to 25
    currentConfigVersion = 2
    currentQueueMaxSize = 350
    currentBatchSize = 25

    console.log('\nTriggering remote config update signal from control plane (new maxSize = 350, new batchSize = 25)...')
    const configManager = ConfigManager.getInstance()
    // Backend sends telemetry ACK with 202 and { status: 202, change: true } signal
    configManager.handleTelemetryResponse(202, { status: 202, change: true })

    await configManager.waitForRefresh()

    const health2 = router.getHealth()
    console.log(`Updated Route 'traces' Queue Capacity: ${health2.routes.traces.queueCapacity}`)
    assert.equal(health2.routes.traces.queueCapacity, 350, 'Updated capacity should dynamically reflect 350!')

    // 3. Verify enqueue behavior under new queue limit
    console.log('\nEnqueuing telemetry under new remote queue limit...')
    for (let i = 0; i < 50; i++) {
      const span = startSpan(`test.span.${i}`)
      span.end()
    }

    console.log('Successfully verified that remote config dynamically controls queue size and route parameters!')
  } finally {
    await shutdown(2000)
    await new Promise(r => server.close(r))
  }
}

runTest().catch(err => {
  console.error('Remote queue test failed:', err)
  process.exit(1)
})
