import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { gzipSync, brotliCompressSync, deflateSync } from 'node:zlib'
import {
  RemoteConfigMockServer,
  createDefaultMockConfig,
  computeConfigHash,
  ALL_10_ROUTES,
  withMockServer,
  setupTestSdk,
  resetSdkState,
  captureProcessBaseline,
  assertNoProcessLeaks,
  assertValidBatchHeaders,
  assertAuthHeader,
  assertGzipCompressed,
  assertUncompressed,
  waitForCondition,
} from './index.js'
import type { SDKEvent, MessageEvent, ErrorEvent } from '../../../src/types/event.js'
import { captureError, flush } from '../../../src/index.js'

describe('RemoteConfigMockServer & E2E Test Harness', () => {
  let server: RemoteConfigMockServer

  beforeEach(async () => {
    server = new RemoteConfigMockServer()
    await server.start()
  })

  afterEach(async () => {
    await resetSdkState()
    await server.stop()
  })

  // ─── 1. Lifecycle & Dynamic Port Binding ─────────────────────────────────

  describe('Lifecycle & Port Binding', () => {
    it('binds to dynamic ephemeral port and formats valid baseUrl', () => {
      assert.ok(server.port > 0, `Expected assigned port > 0, got ${server.port}`)
      assert.equal(server.url, `http://127.0.0.1:${server.port}`)
      assert.equal(server.baseUrl, server.url)
    })

    it('start() is idempotent and returns existing URL', async () => {
      const url1 = server.url
      const url2 = await server.start()
      assert.equal(url1, url2)
    })

    it('tracks active sockets and destroys them on stop() without hanging', async () => {
      await new Promise<void>(resolve => {
        const req = http.request(
          `${server.url}/api/v1/init`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
          },
          res => {
            res.resume()
          },
        )
        req.on('error', () => {}) // absorb connection reset upon stop()
        req.write('{}')
        req.end()
        resolve()
      })

      // Ensure stop completes quickly
      const stopStart = Date.now()
      await server.stop()
      const stopDuration = Date.now() - stopStart
      assert.ok(stopDuration < 1_000, `Expected server.stop() to finish in < 1000ms, took ${stopDuration}ms`)
      assert.equal(server.port, 0)
    })

    it('reset() clears requests, faults, and restores pristine config', async () => {
      server.chaosEngine.injectStatus('*', 500, {}, {}, 10)
      server.flagConfigChanged(true)

      // Make a request to record history
      await sendPost(`${server.url}/api/v1/init`, {})

      assert.equal(server.getReceivedRequests().length, 1)
      assert.equal(server.chaosEngine.getRules().length, 1)

      server.reset()

      assert.equal(server.getReceivedRequests().length, 0)
      assert.equal(server.chaosEngine.getRules().length, 0)
    })
  })

  // ─── 2. Control-Plane Endpoints & ETag Negotiation ────────────────────────

  describe('Control-Plane Endpoints (/init and /sdk-config)', () => {
    it('serves valid Schema-v1 config at /api/v1/init with matching identity and ETag', async () => {
      const res = await sendPost(`${server.url}/api/v1/init`, {})
      assert.equal(res.statusCode, 200)
      assert.ok(res.headers['etag'], 'Expected ETag header on /api/v1/init response')

      const body = JSON.parse(res.body)
      assert.equal(body.success, true)
      assert.equal(body.projectId, server.config.sdk.projectId)
      assert.equal(body.environment, server.config.sdk.environment)
      assert.equal(body.release, server.config.sdk.release)
      assert.equal(body.config.schemaVersion, 1)
      assert.equal(typeof body.config.features, 'object')
      assert.equal(typeof body.config.transport.routes, 'object')
    })

    it('serves /v1/init alias path identically to /api/v1/init', async () => {
      const res = await sendPost(`${server.url}/v1/init`, {})
      assert.equal(res.statusCode, 200)
      const body = JSON.parse(res.body)
      assert.equal(body.success, true)
      assert.equal(body.projectId, server.config.sdk.projectId)
    })

    it('serves /api/v1/sdk-config and returns HTTP 304 Not Modified when ETag matches', async () => {
      // First fetch to get active ETag
      const initialRes = await sendPost(`${server.url}/api/v1/sdk-config`, {})
      assert.equal(initialRes.statusCode, 200)
      const currentEtag = initialRes.headers['etag'] as string
      assert.ok(currentEtag, 'ETag must be present')

      // Second fetch sending exact If-None-Match
      const cacheRes = await sendPost(`${server.url}/api/v1/sdk-config`, {}, {
        'If-None-Match': currentEtag,
      })
      assert.equal(cacheRes.statusCode, 304)
      assert.equal(cacheRes.body, '')

      // Third fetch sending weak W/ formatted If-None-Match
      const weakRes = await sendPost(`${server.url}/api/v1/sdk-config`, {}, {
        'If-None-Match': `W/${currentEtag}`,
      })
      assert.equal(weakRes.statusCode, 304)
    })

    it('serves /api/v1/sdk-config HTTP 200 with updated payload when If-None-Match differs', async () => {
      server.mutateConfig(draft => {
        draft.features.profiling = false
      })

      const res = await sendPost(`${server.url}/api/v1/sdk-config`, {}, {
        'If-None-Match': 'sha256:old-stale-hash',
      })
      assert.equal(res.statusCode, 200)
      const body = JSON.parse(res.body)
      const servedConfig = body.config ?? body
      assert.equal(servedConfig.features.profiling, false)
    })
  })

  // ─── 3. Telemetry Ingestion & Decompression across all 10 Routes ─────────

  describe('Telemetry Ingestion & Compression', () => {
    it('dynamically rewrites all 10 route URLs to mock server baseUrl', () => {
      const config = server.config
      for (const route of ALL_10_ROUTES) {
        assert.equal(
          config.transport.routes[route].url,
          `${server.url}/api/v1/${route}`,
          `Route "${route}" URL was not rewritten to mock server origin`,
        )
      }
    })

    it('ingests and decompresses Content-Encoding: gzip telemetry across all 10 routes', async () => {
      for (const route of ALL_10_ROUTES) {
        const mockEvent: MessageEvent = {
          eventId: `evt-${route}-001`,
          timestamp: Date.now(),
          type: 'message',
          message: `test message for route ${route}`,
          severity: 'info',
          context: { route, test: true },
          metadata: {
            sdkName: 'pulse-sdk',
            sdkVersion: '1.0.0',
            applicationName: 'e2e-app',
            applicationVersion: '1.0.0',
            projectId: 'e2e-project-001',
            environment: 'test',
            release: '1.0.0',
          },
        }

        const batchPayload = {
          events: [mockEvent],
          route,
          timestamp: Date.now(),
        }

        const compressed = gzipSync(Buffer.from(JSON.stringify(batchPayload)))

        const res = await sendPost(
          `${server.url}/api/v1/${route}`,
          compressed,
          {
            'Content-Type': 'application/json',
            'Content-Encoding': 'gzip',
            'X-Route': route,
            'x-pulse-internal': '1',
            'Authorization': 'Bearer test-e2e-api-key',
          },
          true,
        )

        assert.equal(res.statusCode, 200)
        const resBody = JSON.parse(res.body)
        assert.equal(resBody.success, true)
        assert.equal(resBody.received, 1)

        const recordedEvents = server.getReceivedEvents(route)
        assert.equal(recordedEvents.length, 1)
        assert.equal(recordedEvents[0]?.eventId, `evt-${route}-001`)

        const recordedReq = server.getLatestRequest(route)
        assert.ok(recordedReq)
        assertValidBatchHeaders(recordedReq, route)
        assertGzipCompressed(recordedReq)
        assertAuthHeader(recordedReq, 'test-e2e-api-key')
      }
    })

    it('decompresses Content-Encoding: br (Brotli) and deflate payloads', async () => {
      const testEvent: MessageEvent = {
        eventId: 'evt-br-001',
        timestamp: Date.now(),
        type: 'message',
        message: 'brotli message',
        severity: 'info',
        context: { compressed: 'brotli' },
        metadata: {
          sdkName: 'pulse-sdk',
          sdkVersion: '1.0.0',
          applicationName: 'e2e-app',
          applicationVersion: '1.0.0',
          projectId: 'e2e-project-001',
          environment: 'test',
          release: '1.0.0',
        },
      }
      const brPayload = brotliCompressSync(Buffer.from(JSON.stringify({ events: [testEvent], route: 'events' })))

      const brRes = await sendPost(
        `${server.url}/api/v1/events`,
        brPayload,
        { 'Content-Type': 'application/json', 'Content-Encoding': 'br', 'X-Route': 'events' },
        true,
      )
      assert.equal(brRes.statusCode, 200)
      assert.equal(server.getReceivedEvents('events')[0]?.eventId, 'evt-br-001')

      // Deflate
      const deflatePayload = deflateSync(
        Buffer.from(JSON.stringify({ events: [{ ...testEvent, eventId: 'evt-deflate-001' }], route: 'events' })),
      )
      const defRes = await sendPost(
        `${server.url}/api/v1/events`,
        deflatePayload,
        { 'Content-Type': 'application/json', 'Content-Encoding': 'deflate', 'X-Route': 'events' },
        true,
      )
      assert.equal(defRes.statusCode, 200)
      const allEvents = server.getReceivedEvents('events')
      assert.ok(allEvents.some(e => e.eventId === 'evt-deflate-001'))
    })

    it('ingests raw uncompressed JSON telemetry cleanly', async () => {
      const rawPayload = {
        events: [
          {
            eventId: 'evt-raw-001',
            timestamp: Date.now(),
            type: 'message',
            message: 'raw log message',
            severity: 'info',
            context: { uncompressed: true },
            metadata: {
              sdkName: 'pulse-sdk',
              sdkVersion: '1.0.0',
              applicationName: 'e2e-app',
              applicationVersion: '1.0.0',
              projectId: 'e2e-project-001',
              environment: 'test',
              release: '1.0.0',
            },
          },
        ],
        route: 'logs',
        timestamp: Date.now(),
      }

      const res = await sendPost(`${server.url}/api/v1/logs`, rawPayload, {
        'Content-Type': 'application/json',
        'X-Route': 'logs',
      })

      assert.equal(res.statusCode, 200)
      const recorded = server.getLatestRequest('logs')
      assert.ok(recorded)
      assertUncompressed(recorded)
      assert.equal(server.getReceivedEvents('logs')[0]?.eventId, 'evt-raw-001')
    })

    it('returns 404 for unknown route endpoints', async () => {
      const res = await sendPost(`${server.url}/api/v1/non-existent-endpoint`, {})
      assert.equal(res.statusCode, 404)
    })
  })

  // ─── 4. Reactive Telemetry ACK Signaling ──────────────────────────────────

  describe('Reactive Telemetry ACK Signaling', () => {
    it('returns HTTP 200 { change: false } by default on ingestion', async () => {
      const res = await sendPost(`${server.url}/api/v1/metrics`, { events: [{ id: '1' }] })
      assert.equal(res.statusCode, 200)
      const body = JSON.parse(res.body)
      assert.equal(body.change, false)
    })

    it('returns HTTP 202 { change: true } on simulateConfigChange() and reverts on subsequent requests', async () => {
      server.simulateConfigChange({
        features: {
          sessionReplay: false,
        },
      })

      // Next telemetry request should receive reactive ACK HTTP 202
      const firstRes = await sendPost(`${server.url}/api/v1/metrics`, { events: [{ id: '1' }] })
      assert.equal(firstRes.statusCode, 202)
      const firstBody = JSON.parse(firstRes.body)
      assert.equal(firstBody.change, true)
      assert.equal(firstBody.status, 202)

      // Subsequent telemetry request should revert back to HTTP 200 { change: false }
      const secondRes = await sendPost(`${server.url}/api/v1/metrics`, { events: [{ id: '2' }] })
      assert.equal(secondRes.statusCode, 200)
      const secondBody = JSON.parse(secondRes.body)
      assert.equal(secondBody.change, false)
    })

    it('arms reactive signal only for a specific route when armConfigRefreshSignal(route) is used', async () => {
      server.armConfigRefreshSignal('errors')

      // Other routes should return normal 200
      const tracesRes = await sendPost(`${server.url}/api/v1/traces`, { events: [{ id: 'trace-1' }] })
      assert.equal(tracesRes.statusCode, 200)
      assert.equal(JSON.parse(tracesRes.body).change, false)

      // Target route 'errors' should receive 202
      const errorsRes = await sendPost(`${server.url}/api/v1/errors`, { events: [{ id: 'err-1' }] })
      assert.equal(errorsRes.statusCode, 202)
      assert.equal(JSON.parse(errorsRes.body).change, true)

      // Next error request should revert to 200
      const errorsRes2 = await sendPost(`${server.url}/api/v1/errors`, { events: [{ id: 'err-2' }] })
      assert.equal(errorsRes2.statusCode, 200)
      assert.equal(JSON.parse(errorsRes2.body).change, false)
    })
  })

  // ─── 5. Chaos Fault Injection Engine ──────────────────────────────────────

  describe('Chaos Engine', () => {
    it('injects artificial latency delays', async () => {
      server.chaosEngine.injectLatency('metrics', 100, 1)

      const start = Date.now()
      const res = await sendPost(`${server.url}/api/v1/metrics`, { events: [] })
      const elapsed = Date.now() - start

      assert.equal(res.statusCode, 200)
      assert.ok(elapsed >= 90, `Expected latency delay >= 90ms, took ${elapsed}ms`)
    })

    it('injects HTTP status code faults (e.g. 429 with Retry-After and 503)', async () => {
      server.chaosEngine.injectRateLimit('requests', 3, 1)

      const res429 = await sendPost(`${server.url}/api/v1/requests`, { events: [] })
      assert.equal(res429.statusCode, 429)
      assert.equal(res429.headers['retry-after'], '3')

      // Second request succeeds because times was 1
      const resOk = await sendPost(`${server.url}/api/v1/requests`, { events: [] })
      assert.equal(resOk.statusCode, 200)

      // 503 Service Unavailable
      server.chaosEngine.injectStatus('errors', 503, { 'Retry-After': '5' }, { error: 'Service Unavailable' }, 1)
      const res503 = await sendPost(`${server.url}/api/v1/errors`, { events: [] })
      assert.equal(res503.statusCode, 503)
      assert.equal(res503.headers['retry-after'], '5')
    })

    it('injects network socket drop / destruction', async () => {
      server.chaosEngine.injectNetworkDrop('init', 1)

      await assert.rejects(
        async () => {
          await sendPost(`${server.url}/api/v1/init`, {})
        },
        /ECONNRESET|socket hang up|premature close|aborted/i,
      )

      // Next request succeeds normally
      const resOk = await sendPost(`${server.url}/api/v1/init`, {})
      assert.equal(resOk.statusCode, 200)
    })

    it('injects malformed JSON syntax string', async () => {
      server.chaosEngine.injectMalformedJson('init', '{"unterminated_json: ', 1)

      const res = await sendPost(`${server.url}/api/v1/init`, {})
      assert.equal(res.statusCode, 200)
      assert.throws(() => JSON.parse(res.body), /Unexpected|JSON/i)
    })

    it('injects invalid schema payload violating Schema-v1', async () => {
      server.chaosEngine.injectInvalidSchema('init', { schemaVersion: 99, unknownField: true }, 1)

      const res = await sendPost(`${server.url}/api/v1/init`, {})
      assert.equal(res.statusCode, 200)
      const body = JSON.parse(res.body)
      assert.equal(body.schemaVersion, 99)
    })

    it('injects corrupt gzip streams', async () => {
      server.chaosEngine.injectCorruptGzip('init', 1)

      const res = await sendPost(`${server.url}/api/v1/init`, {})
      assert.equal(res.statusCode, 200)
      assert.equal(res.headers['content-encoding'], 'gzip')
    })

    it('clearFaults() removes all active chaos rules immediately', async () => {
      server.chaosEngine.injectStatus('*', 500, {}, {}, 10)
      assert.equal(server.chaosEngine.getRules().length, 1)

      server.clearFaults()
      assert.equal(server.chaosEngine.getRules().length, 0)

      const res = await sendPost(`${server.url}/api/v1/init`, {})
      assert.equal(res.statusCode, 200)
    })
  })

  // ─── 6. Recording & Query API ─────────────────────────────────────────────

  describe('Recording & Query API', () => {
    it('records requests and unpacks individual events', async () => {
      const event1: ErrorEvent = {
        eventId: 'evt-101',
        timestamp: 1000,
        type: 'error',
        name: 'TestError',
        message: 'e1',
        stack: [],
        fingerprint: 'fp-1',
        severity: 'error',
        context: { error: 'e1' },
        metadata: {
          sdkName: 'p',
          sdkVersion: '1',
          applicationName: 'e2e-app',
          applicationVersion: '1.0.0',
          projectId: 'p',
          environment: 't',
          release: '1',
        },
      }
      const event2: ErrorEvent = {
        eventId: 'evt-102',
        timestamp: 1001,
        type: 'error',
        name: 'TestError2',
        message: 'e2',
        stack: [],
        fingerprint: 'fp-2',
        severity: 'error',
        context: { error: 'e2' },
        metadata: {
          sdkName: 'p',
          sdkVersion: '1',
          applicationName: 'e2e-app',
          applicationVersion: '1.0.0',
          projectId: 'p',
          environment: 't',
          release: '1',
        },
      }

      await sendPost(`${server.url}/api/v1/errors`, { events: [event1, event2] })

      const requests = server.getReceivedRequests('errors')
      assert.equal(requests.length, 1)
      assert.equal(requests[0]?.events.length, 2)

      const events = server.getReceivedEvents('errors')
      assert.equal(events.length, 2)
      assert.equal(events[0]?.eventId, 'evt-101')
      assert.equal(events[1]?.eventId, 'evt-102')
      assert.equal(server.getReceivedEventCount('errors'), 2)
    })

    it('waitForRequests() resolves when count is reached and rejects on timeout', async () => {
      // Async dispatch
      setTimeout(() => {
        void sendPost(`${server.url}/api/v1/crons`, { events: [] })
      }, 50)

      const matched = await server.waitForRequests('crons', { count: 1, timeoutMs: 1_000 })
      assert.equal(matched.length, 1)

      // Timeout expectation
      await assert.rejects(
        async () => {
          await server.waitForRequests('nonexistent', { count: 1, timeoutMs: 100 })
        },
        /Timeout waiting for 1 requests/i,
      )
    })

    it('waitForEvents() resolves when matching events arrive', async () => {
      setTimeout(() => {
        void sendPost(`${server.url}/api/v1/logs`, {
          events: [
            {
              eventId: 'log-target-99',
              timestamp: Date.now(),
              type: 'message',
              message: 'hello',
              severity: 'info',
              context: { msg: 'hello' },
              metadata: {
                sdkName: 'p',
                sdkVersion: '1',
                applicationName: 'e2e-app',
                applicationVersion: '1.0.0',
                projectId: 'p',
                environment: 't',
                release: '1',
              },
            },
          ],
        })
      }, 50)

      const events = await server.waitForEvents(
        (evt: SDKEvent) => evt.eventId === 'log-target-99',
        { count: 1, timeoutMs: 1_000 },
      )
      assert.equal(events.length, 1)
      assert.equal(events[0]?.eventId, 'log-target-99')
    })
  })

  // ─── 7. Authentication Scrutiny ───────────────────────────────────────────

  describe('API Key Authentication', () => {
    it('accepts matching API key and rejects mismatched key when requireApiKey is configured', async () => {
      const authServer = new RemoteConfigMockServer({ requireApiKey: 'secret-api-key-99' })
      await authServer.start()

      try {
        // Without key: 401
        const resNoKey = await sendPost(`${authServer.url}/api/v1/init`, {})
        assert.equal(resNoKey.statusCode, 401)

        // With wrong key: 401
        const resBadKey = await sendPost(`${authServer.url}/api/v1/init`, {}, { 'x-api-key': 'wrong-key' })
        assert.equal(resBadKey.statusCode, 401)

        // With X-API-Key: 200
        const resValidKey = await sendPost(`${authServer.url}/api/v1/init`, {}, { 'x-api-key': 'secret-api-key-99' })
        assert.equal(resValidKey.statusCode, 200)

        // With Bearer Authorization header: 200
        const resBearer = await sendPost(`${authServer.url}/api/v1/init`, {}, {
          'authorization': 'Bearer secret-api-key-99',
        })
        assert.equal(resBearer.statusCode, 200)
      } finally {
        await authServer.stop()
      }
    })
  })

  // ─── 8. Scoped Runner & End-to-End SDK Integration ────────────────────────

  describe('SDK Integration & Scoped Runner', () => {
    it('executes cleanly inside withMockServer() and performs teardown', async () => {
      await withMockServer(async (mockServer, url) => {
        assert.ok(url.startsWith('http://127.0.0.1:'))
        const res = await sendPost(`${url}/api/v1/init`, {})
        assert.equal(res.statusCode, 200)
      })
    })

    it('initializes SDK against mock server and flushes captured telemetry', async () => {
      const baseline = captureProcessBaseline()

      const initConfig = await setupTestSdk(server)
      assert.ok(initConfig)
      assert.equal(initConfig.schemaVersion, 1)

      // Capture an error
      captureError(new Error('E2E test error for mock server'))
      await flush()

      // Verify mock server received the error batch
      const errorRequests = await server.waitForRequests('errors', { count: 1, timeoutMs: 3_000 })
      assert.ok(errorRequests.length >= 1)

      const errorEvents = server.getReceivedEvents('errors')
      assert.ok(errorEvents.length >= 1)
      assert.equal(errorEvents[0]?.type, 'error')

      await resetSdkState()
      assertNoProcessLeaks(baseline)
    })
  })
})

// ─── HTTP Helper Utility ───────────────────────────────────────────────────

interface HttpResponse {
  statusCode: number
  headers: http.IncomingHttpHeaders
  body: string
}

function sendPost(
  urlStr: string,
  body: unknown,
  headers: Record<string, string> = {},
  isBinary = false,
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr)
    let payloadBuffer: Buffer
    if (isBinary && Buffer.isBuffer(body)) {
      payloadBuffer = body
    } else if (typeof body === 'string') {
      payloadBuffer = Buffer.from(body, 'utf8')
    } else {
      payloadBuffer = Buffer.from(JSON.stringify(body ?? {}), 'utf8')
    }

    const reqHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      'Content-Length': String(payloadBuffer.length),
      ...headers,
    }

    const req = http.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        headers: reqHeaders,
      },
      res => {
        const chunks: Buffer[] = []
        res.on('data', chunk => chunks.push(Buffer.from(chunk)))
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          })
        })
      },
    )

    req.on('error', reject)
    req.write(payloadBuffer)
    req.end()
  })
}
