import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { gzipSync, brotliCompressSync, deflateSync } from 'node:zlib'
import {
  RemoteConfigMockServer,
  ALL_10_ROUTES,
  createDefaultMockConfig,
  computeConfigHash,
  captureProcessBaseline,
  assertNoProcessLeaks,
} from './index.js'
import type { SDKEvent, MessageEvent, ErrorEvent } from '../../../src/types/event.js'

// Helper for sending HTTP requests with Promise support
interface HttpResponse {
  statusCode: number
  headers: http.IncomingHttpHeaders
  body: string
  rawBody: Buffer
}

function httpRequest(
  urlStr: string,
  options: {
    method?: string
    headers?: Record<string, string>
    body?: Buffer | string | object
    timeout?: number
    agent?: http.Agent
  } = {},
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr)
    let payloadBuffer: Buffer

    if (Buffer.isBuffer(options.body)) {
      payloadBuffer = options.body
    } else if (typeof options.body === 'string') {
      payloadBuffer = Buffer.from(options.body, 'utf8')
    } else if (options.body !== undefined) {
      payloadBuffer = Buffer.from(JSON.stringify(options.body), 'utf8')
    } else {
      payloadBuffer = Buffer.alloc(0)
    }

    const reqHeaders: Record<string, string> = {
      'Content-Length': String(payloadBuffer.length),
      ...options.headers,
    }

    const req = http.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: options.method ?? 'POST',
        headers: reqHeaders,
        timeout: options.timeout ?? 10_000,
        agent: options.agent,
      },
      res => {
        const chunks: Buffer[] = []
        res.on('data', chunk => chunks.push(Buffer.from(chunk)))
        res.on('end', () => {
          const raw = Buffer.concat(chunks)
          resolve({
            statusCode: res.statusCode ?? 0,
            headers: res.headers,
            body: raw.toString('utf8'),
            rawBody: raw,
          })
        })
      },
    )

    req.on('error', reject)
    req.on('timeout', () => {
      req.destroy(new Error(`Request timed out after ${options.timeout ?? 10_000}ms`))
    })

    if (payloadBuffer.length > 0) {
      req.write(payloadBuffer)
    }
    req.end()
  })
}

describe('RemoteConfigMockServer — Empirical Stress & Adversarial Test Suite', () => {
  // ─── 1. High-Throughput Parallel Ingestion & Gzip Decompression ─────────

  describe('1. High-Throughput Parallel Ingestion & Decompression', () => {
    it('handles 500 concurrent gzip-compressed ingestion batches across all 10 routes without data loss', async () => {
      const server = await RemoteConfigMockServer.start()
      const agent = new http.Agent({ keepAlive: true, maxSockets: 50 })
      try {
        const totalBatches = 500
        const eventsPerBatch = 5
        const expectedTotalEvents = totalBatches * eventsPerBatch

        const tasks: Promise<HttpResponse>[] = []

        for (let i = 0; i < totalBatches; i++) {
          const route = ALL_10_ROUTES[i % ALL_10_ROUTES.length]!
          const batchEvents: MessageEvent[] = []

          for (let j = 0; j < eventsPerBatch; j++) {
            batchEvents.push({
              eventId: `stress-evt-${i}-${j}`,
              timestamp: Date.now(),
              type: 'message',
              message: `Stress test event message #${i}-${j} with some unicode 🚀🔥 and telemetry context`,
              severity: 'info',
              context: { index: i, subIndex: j, route },
              metadata: {
                sdkName: 'pulse-sdk',
                sdkVersion: '3.0.0',
                applicationName: 'stress-test-app',
                applicationVersion: '1.0.0',
                projectId: 'e2e-project-001',
                environment: 'test',
                release: '1.0.0',
              },
            })
          }

          const payload = {
            events: batchEvents,
            route,
            timestamp: Date.now(),
          }

          const compressed = gzipSync(Buffer.from(JSON.stringify(payload)))

          tasks.push(
            httpRequest(`${server.url}/api/v1/${route}`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Content-Encoding': 'gzip',
                'X-Route': route,
                'x-pulse-internal': '1',
                'Authorization': 'Bearer test-e2e-api-key',
              },
              body: compressed,
              agent,
            }),
          )
        }

        const start = Date.now()
        const responses = await Promise.all(tasks)
        const duration = Date.now() - start

        // Assert all 500 requests returned HTTP 200 { success: true, received: 5 }
        assert.equal(responses.length, totalBatches)
        for (const res of responses) {
          assert.equal(res.statusCode, 200)
          const parsed = JSON.parse(res.body)
          assert.equal(parsed.success, true)
          assert.equal(parsed.received, eventsPerBatch)
        }

        // Verify total recorded requests and events
        const recordedRequests = server.getReceivedRequests()
        assert.equal(recordedRequests.length, totalBatches)

        const recordedEvents = server.getReceivedEvents()
        assert.equal(recordedEvents.length, expectedTotalEvents)

        // Verify per-route distribution
        let sumRouteEvents = 0
        for (const route of ALL_10_ROUTES) {
          const routeCount = server.getReceivedEventCount(route)
          assert.ok(routeCount > 0, `Route ${route} should have received events`)
          sumRouteEvents += routeCount
        }
        assert.equal(sumRouteEvents, expectedTotalEvents)

        // Verify specific sample event integrity
        const sample = recordedEvents.find(e => (e as MessageEvent).eventId === 'stress-evt-250-2') as MessageEvent
        assert.ok(sample, 'Sample event 250-2 must be present')
        assert.equal((sample.context as Record<string, unknown>)?.['index'], 250)
        assert.equal((sample.context as Record<string, unknown>)?.['subIndex'], 2)
      } finally {
        agent.destroy()
        await server.stop()
      }
    })

    it('robustly handles mixed encodings (gzip, br, deflate, raw, uppercase header) in parallel', async () => {
      const server = await RemoteConfigMockServer.start()
      try {
        const testPayload = (id: string) => ({
          events: [
            {
              eventId: id,
              timestamp: Date.now(),
              type: 'message',
              message: `Encoding test for ${id}`,
              severity: 'info',
              context: {},
              metadata: {
                sdkName: 'pulse',
                sdkVersion: '1',
                applicationName: 'app',
                applicationVersion: '1',
                projectId: 'p',
                environment: 't',
                release: '1',
              },
            },
          ],
          route: 'events',
        })

        const rawJson = JSON.stringify(testPayload('evt-raw'))
        const gzipBuf = gzipSync(Buffer.from(JSON.stringify(testPayload('evt-gzip'))))
        const brBuf = brotliCompressSync(Buffer.from(JSON.stringify(testPayload('evt-br'))))
        const defBuf = deflateSync(Buffer.from(JSON.stringify(testPayload('evt-deflate'))))
        const upperGzipBuf = gzipSync(Buffer.from(JSON.stringify(testPayload('evt-upper-gzip'))))

        const responses = await Promise.all([
          httpRequest(`${server.url}/api/v1/events`, {
            headers: { 'Content-Type': 'application/json', 'X-Route': 'events' },
            body: rawJson,
          }),
          httpRequest(`${server.url}/api/v1/events`, {
            headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', 'X-Route': 'events' },
            body: gzipBuf,
          }),
          httpRequest(`${server.url}/api/v1/events`, {
            headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'br', 'X-Route': 'events' },
            body: brBuf,
          }),
          httpRequest(`${server.url}/api/v1/events`, {
            headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'deflate', 'X-Route': 'events' },
            body: defBuf,
          }),
          httpRequest(`${server.url}/api/v1/events`, {
            headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'GZIP', 'X-Route': 'events' },
            body: upperGzipBuf,
          }),
        ])

        for (const res of responses) {
          assert.equal(res.statusCode, 200)
        }

        const events = server.getReceivedEvents('events')
        assert.equal(events.length, 5)
        const ids = events.map(e => e.eventId)
        assert.ok(ids.includes('evt-raw'))
        assert.ok(ids.includes('evt-gzip'))
        assert.ok(ids.includes('evt-br'))
        assert.ok(ids.includes('evt-deflate'))
        assert.ok(ids.includes('evt-upper-gzip'))
      } finally {
        await server.stop()
      }
    })

    it('survives corrupted compression streams and malformed bodies without crashing the server process', async () => {
      const server = await RemoteConfigMockServer.start()
      try {
        // Send corrupt gzip stream (invalid magic bytes)
        const corruptGzip = Buffer.from([0x1f, 0x8b, 0x00, 0x99, 0xff, 0xaa, 0xbb])
        const res1 = await httpRequest(`${server.url}/api/v1/traces`, {
          headers: { 'Content-Encoding': 'gzip', 'Content-Type': 'application/json' },
          body: corruptGzip,
        })
        // Server should not crash, returns 200 or handles gracefully
        assert.ok(res1.statusCode === 200 || res1.statusCode === 400)

        // Send non-JSON body
        const res2 = await httpRequest(`${server.url}/api/v1/traces`, {
          headers: { 'Content-Type': 'text/plain' },
          body: 'Not a JSON object at all',
        })
        assert.ok(res2.statusCode === 200 || res2.statusCode === 400)

        // Send empty body with gzip header
        const res3 = await httpRequest(`${server.url}/api/v1/traces`, {
          headers: { 'Content-Encoding': 'gzip', 'Content-Type': 'application/json' },
          body: Buffer.alloc(0),
        })
        assert.ok(res3.statusCode === 200 || res3.statusCode === 400)

        // Subsequent valid request succeeds immediately
        const validPayload = { events: [{ eventId: 'valid-after-corrupt', timestamp: 1, type: 'message', message: 'ok', severity: 'info', context: {}, metadata: { sdkName: 'p', sdkVersion: '1', applicationName: 'a', applicationVersion: '1', projectId: 'p', environment: 't', release: '1' } }] }
        const resValid = await httpRequest(`${server.url}/api/v1/traces`, {
          headers: { 'Content-Type': 'application/json' },
          body: validPayload,
        })
        assert.equal(resValid.statusCode, 200)
        assert.ok(server.getReceivedEvents('traces').some(e => e.eventId === 'valid-after-corrupt'))
      } finally {
        await server.stop()
      }
    })
  })

  // ─── 2. Multiple Concurrent Mock Server Instances ─────────────────────────

  describe('2. Multiple Concurrent Mock Server Instances (Dynamic Port Isolation)', () => {
    it('runs 10 concurrent server instances with completely isolated state, ports, and configs', async () => {
      const serverCount = 10
      const servers: RemoteConfigMockServer[] = []

      try {
        // Start 10 servers concurrently
        for (let i = 0; i < serverCount; i++) {
          const s = new RemoteConfigMockServer({
            initialConfig: {
              sdk: {
                projectId: `isolated-project-${i}`,
                environment: `env-${i}`,
              },
              features: {
                profiling: i % 2 === 0,
              },
            },
          })
          servers.push(s)
        }

        await Promise.all(servers.map(s => s.start()))

        // Verify all 10 have unique ports > 0
        const ports = servers.map(s => s.port)
        const uniquePorts = new Set(ports)
        assert.equal(uniquePorts.size, serverCount, 'All 10 servers must have distinct dynamic ports')

        // Concurrently query /api/v1/init on all 10 servers
        const initResponses = await Promise.all(
          servers.map(s => httpRequest(`${s.url}/api/v1/init`)),
        )

        for (let i = 0; i < serverCount; i++) {
          const res = initResponses[i]!
          assert.equal(res.statusCode, 200)
          const body = JSON.parse(res.body)
          assert.equal(body.projectId, `isolated-project-${i}`)
          assert.equal(body.environment, `env-${i}`)
          assert.equal(body.config.features.profiling, i % 2 === 0)
          assert.equal(body.config.transport.routes.traces.url, `${servers[i]!.url}/api/v1/traces`)
        }

        // Concurrently send telemetry to each server
        const telemetryTasks: Promise<HttpResponse>[] = []
        for (let i = 0; i < serverCount; i++) {
          const s = servers[i]!
          telemetryTasks.push(
            httpRequest(`${s.url}/api/v1/logs`, {
              body: {
                events: [
                  {
                    eventId: `server-${i}-event`,
                    timestamp: Date.now(),
                    type: 'message',
                    message: `Log on server ${i}`,
                    severity: 'info',
                    context: { serverIndex: i },
                    metadata: {
                      sdkName: 'p',
                      sdkVersion: '1',
                      applicationName: 'a',
                      applicationVersion: '1',
                      projectId: `isolated-project-${i}`,
                      environment: `env-${i}`,
                      release: '1',
                    },
                  },
                ],
                route: 'logs',
              },
            }),
          )
        }

        await Promise.all(telemetryTasks)

        // Verify each server recorded only its own event
        for (let i = 0; i < serverCount; i++) {
          const s = servers[i]!
          const events = s.getReceivedEvents('logs')
          assert.equal(events.length, 1)
          assert.equal(events[0]?.eventId, `server-${i}-event`)
        }
      } finally {
        // Concurrently stop all 10 servers
        await Promise.all(servers.map(s => s.stop()))
        for (const s of servers) {
          assert.equal(s.port, 0)
        }
      }
    })
  })

  // ─── 3. Rapid Start / Stop / Reset Cycles & Socket Teardown ───────────────

  describe('3. Rapid Start / Stop / Reset Cycles & Resource Cleanup', () => {
    it('rapidly starts and stops the server 25 times in sequence without port or handle leaks', async () => {
      const baseline = captureProcessBaseline()
      const server = new RemoteConfigMockServer()

      for (let cycle = 0; cycle < 25; cycle++) {
        const url = await server.start()
        assert.ok(url.startsWith('http://127.0.0.1:'))
        assert.ok(server.port > 0)

        // Do a quick request
        const res = await httpRequest(`${server.url}/api/v1/init`)
        assert.equal(res.statusCode, 200)

        await server.stop()
        assert.equal(server.port, 0)
      }

      // Verify no process leaks
      assertNoProcessLeaks(baseline, undefined, 'Rapid start/stop')
    })

    it('immediately aborts and cleans up lingering TCP keep-alive sockets upon stop()', async () => {
      const server = await RemoteConfigMockServer.start()

      // Open a raw TCP connection with keep-alive
      const socket = net.connect({ port: server.port, host: '127.0.0.1' })
      socket.setKeepAlive(true, 1000)

      await new Promise<void>(resolve => {
        socket.on('connect', resolve)
      })

      // Send partial HTTP request without ending
      socket.write('POST /api/v1/init HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 100\r\n\r\n')

      let socketClosed = false
      socket.on('close', () => {
        socketClosed = true
      })
      socket.on('error', () => {}) // absorb reset

      // Calling stop() should instantly destroy active socket
      const stopStart = Date.now()
      await server.stop()
      const elapsed = Date.now() - stopStart

      assert.ok(elapsed < 500, `server.stop() took ${elapsed}ms, must be < 500ms`)

      // Wait a tick to confirm socket close fired
      await new Promise(resolve => setTimeout(resolve, 50))
      assert.equal(socketClosed, true, 'Lingering socket must be closed upon stop()')
    })

    it('handles idempotent multiple consecutive stop() calls safely', async () => {
      const server = await RemoteConfigMockServer.start()
      await server.stop()
      // Consecutive calls should resolve without error
      await server.stop()
      await server.stop()
      assert.equal(server.port, 0)
    })

    it('reset() safely restores pristine state repeatedly during high traffic', async () => {
      const server = await RemoteConfigMockServer.start()
      try {
        for (let i = 0; i < 5; i++) {
          server.chaosEngine.injectStatus('*', 500, {}, {}, 5)
          server.flagConfigChanged(true)
          server.mutateConfig(draft => {
            draft.features.tracing = false
          })

          await httpRequest(`${server.url}/api/v1/init`)
          assert.ok(server.getReceivedRequests().length > 0)
          assert.equal(server.config.features.tracing, false)

          server.reset()

          assert.equal(server.getReceivedRequests().length, 0)
          assert.equal(server.chaosEngine.getRules().length, 0)
          assert.equal(server.config.features.tracing, true)
        }
      } finally {
        await server.stop()
      }
    })
  })

  // ─── 4. Chaos Fault Injection Combinations Under Rapid Fire ───────────────

  describe('4. Chaos Fault Injection Combinations Under Rapid Fire', () => {
    it('accurately counts down rule executions under 100 concurrent requests', async () => {
      const server = await RemoteConfigMockServer.start()
      try {
        // Inject 20 status 503 faults on /api/v1/metrics
        server.chaosEngine.injectStatus('metrics', 503, { 'Retry-After': '10' }, { error: 'chaos 503' }, 20)

        // Fire 100 parallel requests to /api/v1/metrics
        const tasks: Promise<HttpResponse>[] = []
        for (let i = 0; i < 100; i++) {
          tasks.push(httpRequest(`${server.url}/api/v1/metrics`, { body: { events: [] } }))
        }

        const responses = await Promise.all(tasks)

        const count503 = responses.filter(r => r.statusCode === 503).length
        const count200 = responses.filter(r => r.statusCode === 200).length

        assert.equal(count503, 20, `Expected exactly 20 faults (status 503), got ${count503}`)
        assert.equal(count200, 80, `Expected exactly 80 successes (status 200), got ${count200}`)

        // Verify chaos rule list is now empty (expired)
        assert.equal(server.chaosEngine.getRules().length, 0)
      } finally {
        await server.stop()
      }
    })

    it('evaluates rule priority: specific route vs regex path vs wildcard correctly', async () => {
      const server = await RemoteConfigMockServer.start()
      try {
        // Add wildcard rule: 500
        server.chaosEngine.injectStatus('*', 500, {}, { type: 'wildcard' }, 100)
        // Add route-specific rule: 429
        server.chaosEngine.injectStatus('errors', 429, { 'Retry-After': '1' }, { type: 'route-errors' }, 1)

        // Route 'errors' matches the first rule in the list (which is wildcard 500)
        // Or let's test specific route rule when added first:
        server.clearFaults()
        server.chaosEngine.injectStatus('errors', 429, { 'Retry-After': '1' }, { type: 'route-errors' }, 1)
        server.chaosEngine.injectStatus('*', 500, {}, { type: 'wildcard' }, 100)

        const resErrors = await httpRequest(`${server.url}/api/v1/errors`, { body: { events: [] } })
        assert.equal(resErrors.statusCode, 429)

        const resTraces = await httpRequest(`${server.url}/api/v1/traces`, { body: { events: [] } })
        assert.equal(resTraces.statusCode, 500)
      } finally {
        await server.stop()
      }
    })

    it('injects and clears faults concurrently while traffic is actively in-flight', async () => {
      const server = await RemoteConfigMockServer.start()
      try {
        let stopTraffic = false
        const inFlightPromises: Promise<HttpResponse | Error>[] = []

        // Background traffic generator
        const trafficWorker = (async () => {
          let reqId = 0
          while (!stopTraffic) {
            reqId++
            const p = httpRequest(`${server.url}/api/v1/init`, { timeout: 3000 }).catch(err => err as Error)
            inFlightPromises.push(p)
            await new Promise(resolve => setTimeout(resolve, 5))
          }
        })()

        // Concurrently add, mutate, and clear chaos rules
        for (let i = 0; i < 20; i++) {
          server.chaosEngine.injectLatency('init', 20, 2)
          server.chaosEngine.injectStatus('init', 500, {}, {}, 2)
          await new Promise(resolve => setTimeout(resolve, 15))
          server.clearFaults()
        }

        stopTraffic = true
        await trafficWorker
        await Promise.all(inFlightPromises)

        // Verify server is in a pristine state after traffic settles
        const cleanRes = await httpRequest(`${server.url}/api/v1/init`)
        assert.equal(cleanRes.statusCode, 200)
      } finally {
        await server.stop()
      }
    })

    it('handles network drop connection without throwing uncaught exceptions on the server', async () => {
      const server = await RemoteConfigMockServer.start()
      try {
        server.chaosEngine.injectNetworkDrop('traces', 5)

        const tasks: Promise<string>[] = []
        for (let i = 0; i < 5; i++) {
          tasks.push(
            httpRequest(`${server.url}/api/v1/traces`, { body: { events: [] } })
              .then(() => 'success')
              .catch(() => 'connection_dropped'),
          )
        }

        const results = await Promise.all(tasks)
        for (const res of results) {
          assert.equal(res, 'connection_dropped')
        }

        // 6th request succeeds normally
        const normalRes = await httpRequest(`${server.url}/api/v1/traces`, { body: { events: [] } })
        assert.equal(normalRes.statusCode, 200)
      } finally {
        await server.stop()
      }
    })
  })

  // ─── 5. Query API & Concurrency Waiters ────────────────────────────────────

  describe('5. Query API & Concurrency Waiters', () => {
    it('handles multiple concurrent waitForRequests and waitForEvents waiters simultaneously', async () => {
      const server = await RemoteConfigMockServer.start()
      try {
        const waiter1 = server.waitForRequests('metrics', 5, 2000)
        const waiter2 = server.waitForRequests('errors', 3, 2000)
        const waiter3 = server.waitForEvents('metrics', 5, 2000)

        // Concurrently dispatch telemetry
        setTimeout(async () => {
          for (let i = 0; i < 5; i++) {
            await httpRequest(`${server.url}/api/v1/metrics`, {
              body: {
                events: [
                  {
                    eventId: `m-${i}`,
                    timestamp: 1,
                    type: 'metric',
                    name: 'test_metric',
                    value: i,
                    metricType: 'counter',
                    context: {},
                    metadata: { sdkName: 'p', sdkVersion: '1', applicationName: 'a', applicationVersion: '1', projectId: 'p', environment: 't', release: '1' },
                  },
                ],
                route: 'metrics',
              },
            })
          }
        }, 20)

        setTimeout(async () => {
          for (let i = 0; i < 3; i++) {
            await httpRequest(`${server.url}/api/v1/errors`, {
              body: {
                events: [
                  {
                    eventId: `e-${i}`,
                    timestamp: 1,
                    type: 'error',
                    name: 'E',
                    message: 'err',
                    stack: [],
                    fingerprint: 'f',
                    severity: 'error',
                    context: {},
                    metadata: { sdkName: 'p', sdkVersion: '1', applicationName: 'a', applicationVersion: '1', projectId: 'p', environment: 't', release: '1' },
                  },
                ],
                route: 'errors',
              },
            })
          }
        }, 30)

        const [w1Res, w2Res, w3Res] = await Promise.all([waiter1, waiter2, waiter3])

        assert.equal(w1Res.length, 5)
        assert.equal(w2Res.length, 3)
        assert.equal(w3Res.length, 5)
      } finally {
        await server.stop()
      }
    })
  })

  // ─── 6. Multi-Megabyte Ingestion & Chunked Payload Streaming ─────────────

  describe('6. Multi-Megabyte Ingestion & Streaming', () => {
    it('ingests and parses 2MB payload containing 1,000 telemetry events without memory exhaustion', async () => {
      const server = await RemoteConfigMockServer.start()
      try {
        const events: MessageEvent[] = []
        for (let i = 0; i < 1_000; i++) {
          events.push({
            eventId: `large-batch-evt-${i}`,
            timestamp: Date.now(),
            type: 'message',
            message: `Large payload event ${i} with detailed trace stack and attributes padding: ${'x'.repeat(200)}`,
            severity: 'info',
            context: { index: i, largeString: 'y'.repeat(500) },
            metadata: {
              sdkName: 'pulse-sdk',
              sdkVersion: '3.0.0',
              applicationName: 'stress-test-app',
              applicationVersion: '1.0.0',
              projectId: 'e2e-project-001',
              environment: 'test',
              release: '1.0.0',
            },
          })
        }

        const rawJson = JSON.stringify({ events, route: 'events', timestamp: Date.now() })
        assert.ok(rawJson.length > 500_000, `Raw JSON size should be > 500KB, got ${rawJson.length}`)
        const compressed = gzipSync(Buffer.from(rawJson))
        assert.ok(compressed.length > 5_000, `Compressed size should be > 5KB, got ${compressed.length}`)

        const res = await httpRequest(`${server.url}/api/v1/events`, {
          headers: {
            'Content-Type': 'application/json',
            'Content-Encoding': 'gzip',
            'X-Route': 'events',
          },
          body: compressed,
        })

        assert.equal(res.statusCode, 200)
        assert.equal(JSON.parse(res.body).received, 1_000)

        const recorded = server.getReceivedEvents('events')
        assert.equal(recorded.length, 1_000)
        assert.equal(recorded[999]?.eventId, 'large-batch-evt-999')
      } finally {
        await server.stop()
      }
    })
  })

  // ─── 7. URL Variants, Trailing Slashes & Query Parameter Normalization ────

  describe('7. URL Variants, Trailing Slashes & Route Resolution', () => {
    it('correctly maps trailing slashes and query parameters to the expected route', async () => {
      const server = await RemoteConfigMockServer.start()
      try {
        const testRoutes = [
          { url: `${server.url}/api/v1/traces/`, expectedRoute: 'traces' },
          { url: `${server.url}/v1/spans?sdk=node&v=3.0`, expectedRoute: 'spans' },
          { url: `${server.url}/errors/?filter=all`, expectedRoute: 'errors' },
          { url: `${server.url}/api/v1/checkins`, expectedRoute: 'crons' },
        ]

        for (const tr of testRoutes) {
          const res = await httpRequest(tr.url, {
            body: {
              events: [
                {
                  eventId: `norm-evt-${tr.expectedRoute}`,
                  timestamp: Date.now(),
                  type: 'message',
                  message: `Testing route ${tr.expectedRoute}`,
                  severity: 'info',
                  context: {},
                  metadata: { sdkName: 'p', sdkVersion: '1', applicationName: 'a', applicationVersion: '1', projectId: 'p', environment: 't', release: '1' },
                },
              ],
            },
          })

          assert.equal(res.statusCode, 200, `Failed for URL ${tr.url}`)
          const events = server.getReceivedEvents(tr.expectedRoute)
          assert.ok(
            events.some(e => e.eventId === `norm-evt-${tr.expectedRoute}`),
            `Event for route ${tr.expectedRoute} was not recorded properly from URL ${tr.url}`,
          )
        }
      } finally {
        await server.stop()
      }
    })
  })

  // ─── 8. High-Concurrency Reactive ACK & Dynamic Mutation Race ─────────────

  describe('8. Reactive ACK & Dynamic Mutation Concurrency', () => {
    it('coordinates simultaneous simulateConfigChange calls and reactive ACK deliveries across concurrent requests', async () => {
      const server = await RemoteConfigMockServer.start()
      const agent = new http.Agent({ keepAlive: true, maxSockets: 30 })
      try {
        let ack202Count = 0
        let ack200Count = 0

        // Arm config change
        server.simulateConfigChange({ features: { profiling: false } })

        // Concurrently fire 50 requests
        const tasks = Array.from({ length: 50 }, (_, i) =>
          httpRequest(`${server.url}/api/v1/traces`, {
            body: { events: [{ eventId: `ack-trace-${i}`, timestamp: 1, type: 'message', message: 't', severity: 'info', context: {}, metadata: { sdkName: 'p', sdkVersion: '1', applicationName: 'a', applicationVersion: '1', projectId: 'p', environment: 't', release: '1' } }] },
            agent,
          }).then(res => {
            if (res.statusCode === 202) {
              const body = JSON.parse(res.body)
              if (body.change === true) ack202Count++
            } else if (res.statusCode === 200) {
              ack200Count++
            }
          }),
        )

        await Promise.all(tasks)

        // Exactly one request should have received the armed 202 ACK change trigger
        assert.equal(ack202Count, 1, `Expected exactly 1 request to receive 202 ACK, got ${ack202Count}`)
        assert.equal(ack200Count, 49, `Expected 49 requests to receive 200 ACK, got ${ack200Count}`)
      } finally {
        agent.destroy()
        await server.stop()
      }
    })
  })

  // ─── 9. Chaos Engine Boundary & Out-of-Bounds Input Fuzzing ──────────────

  describe('9. Chaos Engine Boundary & Input Fuzzing', () => {
    it('handles negative delays, standard expiration, and unusual status codes gracefully', async () => {
      const server = await RemoteConfigMockServer.start()
      try {
        // Negative delayMs: should not hang or crash
        server.chaosEngine.injectLatency('traces', -10, 1)
        const res1 = await httpRequest(`${server.url}/api/v1/traces`, { body: { events: [] } })
        assert.equal(res1.statusCode, 200)

        // times: 1 -> rule executes once, second request succeeds
        server.chaosEngine.injectStatus('traces', 503, {}, {}, 1)
        const res2 = await httpRequest(`${server.url}/api/v1/traces`, { body: { events: [] } })
        assert.equal(res2.statusCode, 503)
        const res3 = await httpRequest(`${server.url}/api/v1/traces`, { body: { events: [] } })
        assert.equal(res3.statusCode, 200)

        // Custom high status code: 418 I'm a teapot
        server.chaosEngine.injectStatus('traces', 418, { 'X-Teapot': 'true' }, { error: 'I am a teapot' }, 1)
        const res4 = await httpRequest(`${server.url}/api/v1/traces`, { body: { events: [] } })
        assert.equal(res4.statusCode, 418)
        assert.equal(res4.headers['x-teapot'], 'true')
      } finally {
        await server.stop()
      }
    })

    it('demonstrates empirical edge-case where times: 0 executes once due to pre-decrement check in evaluate', async () => {
      const server = await RemoteConfigMockServer.start()
      try {
        // When times: 0 is injected, normalizedTimes is 0.
        // During evaluate: remaining is (0 - 1) = -1 <= 0, rule is spliced, but the fault is executed once on that request.
        server.chaosEngine.injectStatus('traces', 500, {}, {}, 0)
        const res = await httpRequest(`${server.url}/api/v1/traces`, { body: { events: [] } })
        // Empirically observes status 500 (demonstrating defect in times: 0 handling)
        assert.equal(res.statusCode, 500, 'Empirical proof that times: 0 executes once before splicing')

        // Subsequent request succeeds because rule was spliced
        const res2 = await httpRequest(`${server.url}/api/v1/traces`, { body: { events: [] } })
        assert.equal(res2.statusCode, 200)
      } finally {
        await server.stop()
      }
    })
  })
})

