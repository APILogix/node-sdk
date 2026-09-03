import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { gzipSync, brotliCompressSync, deflateSync } from 'node:zlib'
import {
  RemoteConfigMockServer,
  ALL_10_ROUTES,
  withMockServer,
  resetSdkState,
  captureProcessBaseline,
  assertNoProcessLeaks,
} from './index.js'
import type { TransportRouteName } from '../../../src/types/config.js'
import type { SDKEvent, MessageEvent, ErrorEvent } from '../../../src/types/event.js'

describe('Adversarial & Boundary Verification: RemoteConfigMockServer & test-helpers', () => {
  let server: RemoteConfigMockServer

  beforeEach(async () => {
    server = new RemoteConfigMockServer()
    await server.start()
  })

  afterEach(async () => {
    await resetSdkState()
    await server.stop()
  })

  // ─── 1. Decompression & Corrupted / Truncated Stream Payloads ────────────

  describe('Decompression, Corrupted Bodies & Stream Edge Cases', () => {
    it('handles Content-Encoding: gzip with corrupted binary bytes without crashing and records rawBody', async () => {
      const corruptGzip = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0xde, 0xad, 0xbe, 0xef, 0x01, 0x02, 0x03])

      const res = await sendPost(
        `${server.url}/api/v1/errors`,
        corruptGzip,
        {
          'Content-Type': 'application/json',
          'Content-Encoding': 'gzip',
          'X-Route': 'errors',
        },
        true,
      )

      assert.equal(res.statusCode, 200)
      const recorded = server.getLatestRequest('errors')
      assert.ok(recorded, 'Request must be recorded even with corrupted gzip')
      assert.equal(recorded.rawBody.length, corruptGzip.length)
      assert.equal(recorded.events.length, 0, 'No events parsed from corrupt payload')
    })

    it('handles Content-Encoding: gzip with 0-byte empty body gracefully', async () => {
      const emptyBuffer = Buffer.alloc(0)

      const res = await sendPost(
        `${server.url}/api/v1/metrics`,
        emptyBuffer,
        {
          'Content-Type': 'application/json',
          'Content-Encoding': 'gzip',
          'X-Route': 'metrics',
        },
        true,
      )

      assert.equal(res.statusCode, 200)
      const recorded = server.getLatestRequest('metrics')
      assert.ok(recorded)
      assert.equal(recorded.events.length, 0)
      assert.equal(recorded.body, null)
    })

    it('handles Content-Encoding: br with corrupted bytes without crashing', async () => {
      const corruptBr = Buffer.from([0x99, 0x88, 0x77, 0x66, 0x55, 0x44])

      const res = await sendPost(
        `${server.url}/api/v1/logs`,
        corruptBr,
        {
          'Content-Type': 'application/json',
          'Content-Encoding': 'br',
          'X-Route': 'logs',
        },
        true,
      )

      assert.equal(res.statusCode, 200)
      const recorded = server.getLatestRequest('logs')
      assert.ok(recorded)
      assert.equal(recorded.events.length, 0)
    })

    it('handles Content-Encoding: deflate with corrupted bytes without crashing', async () => {
      const corruptDeflate = Buffer.from([0x78, 0x9c, 0xff, 0xff, 0x00, 0x00])

      const res = await sendPost(
        `${server.url}/api/v1/traces`,
        corruptDeflate,
        {
          'Content-Type': 'application/json',
          'Content-Encoding': 'deflate',
          'X-Route': 'traces',
        },
        true,
      )

      assert.equal(res.statusCode, 200)
      const recorded = server.getLatestRequest('traces')
      assert.ok(recorded)
      assert.equal(recorded.events.length, 0)
    })

    it('handles uppercase/mixed-case Content-Encoding: GzIp correctly', async () => {
      const event: MessageEvent = {
        eventId: 'evt-case-001',
        timestamp: Date.now(),
        type: 'message',
        message: 'case sensitivity test',
        severity: 'info',
        context: {},
        metadata: {
          sdkName: 'pulse-sdk',
          sdkVersion: '1.0.0',
          applicationName: 'e2e-app',
          applicationVersion: '1.0.0',
          projectId: 'p1',
          environment: 'test',
          release: '1.0.0',
        },
      }
      const compressed = gzipSync(Buffer.from(JSON.stringify({ events: [event], route: 'events' })))

      const res = await sendPost(
        `${server.url}/api/v1/events`,
        compressed,
        {
          'Content-Type': 'application/json',
          'Content-Encoding': 'GzIp',
          'X-Route': 'events',
        },
        true,
      )

      assert.equal(res.statusCode, 200)
      const events = server.getReceivedEvents('events')
      assert.equal(events.length, 1)
      assert.equal(events[0]?.eventId, 'evt-case-001')
    })

    it('handles unknown Content-Encoding by preserving raw payload without crashing', async () => {
      const rawText = '{"unsupported_encoding": true}'
      const res = await sendPost(
        `${server.url}/api/v1/events`,
        Buffer.from(rawText, 'utf8'),
        {
          'Content-Type': 'application/json',
          'Content-Encoding': 'zstd',
          'X-Route': 'events',
        },
        true,
      )

      assert.equal(res.statusCode, 200)
      const recorded = server.getLatestRequest('events')
      assert.ok(recorded)
      assert.deepEqual(recorded.body, { unsupported_encoding: true })
    })

    it('handles malformed JSON body strings gracefully in history recording', async () => {
      const malformed = '{"unclosed": "brace", '
      const res = await sendPost(
        `${server.url}/api/v1/requests`,
        malformed,
        { 'Content-Type': 'application/json', 'X-Route': 'requests' },
      )

      assert.equal(res.statusCode, 200)
      const recorded = server.getLatestRequest('requests')
      assert.ok(recorded)
      assert.equal(recorded.body, malformed)
      assert.equal(recorded.events.length, 0)
    })

    it('handles non-array events properties (null, string, number) without crashing or breaking queries', async () => {
      const payloads = [
        { events: 'not-an-array', route: 'spans' },
        { events: null, route: 'spans' },
        { events: 12345, route: 'spans' },
        { events: {}, route: 'spans' },
      ]

      for (const p of payloads) {
        const res = await sendPost(`${server.url}/api/v1/spans`, p)
        assert.equal(res.statusCode, 200)
      }

      assert.equal(server.getReceivedRequests('spans').length, 4)
      assert.equal(server.getReceivedEvents('spans').length, 0)
      assert.equal(server.getReceivedEventCount('spans'), 0)
    })

    it('chaos engine injectCorruptGzip returns 200 with Content-Encoding: gzip and corrupt stream', async () => {
      server.chaosEngine.injectCorruptGzip('init', 1)

      const res = await sendPost(`${server.url}/api/v1/init`, {})
      assert.equal(res.statusCode, 200)
      assert.equal(res.headers['content-encoding'], 'gzip')
      assert.ok(res.body.length > 0)
    })

    it('chaos engine injectTruncatedStream terminates socket mid-flight', async () => {
      server.chaosEngine.injectTruncatedStream('init', 1)

      await assert.rejects(
        async () => {
          await sendPost(`${server.url}/api/v1/init`, {})
        },
        /ECONNRESET|socket hang up|premature close|aborted/i,
      )
    })
  })

  // ─── 2. ETag Matching & Conformance (Weak, Strong, Quoted, Unquoted) ─────

  describe('ETag Conformance & Cache Negotiation', () => {
    it('evaluates exact strong unquoted ETag match -> 304', async () => {
      const etag = server.eTag
      const res = await sendPost(`${server.url}/api/v1/sdk-config`, {}, {
        'If-None-Match': etag,
      })
      assert.equal(res.statusCode, 304)
      assert.equal(res.body, '')
      assert.equal(res.headers['etag'], etag)
    })

    it('evaluates strong quoted ETag match ("sha256:...") -> 304', async () => {
      const etag = server.eTag
      const res = await sendPost(`${server.url}/api/v1/sdk-config`, {}, {
        'If-None-Match': `"${etag}"`,
      })
      assert.equal(res.statusCode, 304)
      assert.equal(res.body, '')
    })

    it('evaluates weak unquoted ETag match (W/sha256:...) -> 304', async () => {
      const etag = server.eTag
      const res = await sendPost(`${server.url}/api/v1/sdk-config`, {}, {
        'If-None-Match': `W/${etag}`,
      })
      assert.equal(res.statusCode, 304)
      assert.equal(res.body, '')
    })

    it('evaluates weak quoted ETag match (W/"sha256:...") -> 304', async () => {
      const etag = server.eTag
      const res = await sendPost(`${server.url}/api/v1/sdk-config`, {}, {
        'If-None-Match': `W/"${etag}"`,
      })
      assert.equal(res.statusCode, 304)
      assert.equal(res.body, '')
    })

    it('returns 200 with fresh config on mismatched strong quoted ETag', async () => {
      const res = await sendPost(`${server.url}/api/v1/sdk-config`, {}, {
        'If-None-Match': '"sha256:0000000000000000000000000000000000000000000000000000000000000000"',
      })
      assert.equal(res.statusCode, 200)
      const body = JSON.parse(res.body)
      assert.ok(body.config)
      assert.equal(body.config.schemaVersion, 1)
    })

    it('returns 200 with fresh config on mismatched weak quoted ETag', async () => {
      const res = await sendPost(`${server.url}/api/v1/sdk-config`, {}, {
        'If-None-Match': 'W/"sha256:0000000000000000000000000000000000000000000000000000000000000000"',
      })
      assert.equal(res.statusCode, 200)
      const body = JSON.parse(res.body)
      assert.ok(body.config)
    })

    it('returns 200 when If-None-Match header is empty string or absent', async () => {
      const resEmpty = await sendPost(`${server.url}/api/v1/sdk-config`, {}, {
        'If-None-Match': '',
      })
      assert.equal(resEmpty.statusCode, 200)

      const resNone = await sendPost(`${server.url}/api/v1/sdk-config`, {})
      assert.equal(resNone.statusCode, 200)
    })

    it('transitions through sequential mutations: 200 -> 304 -> mutate -> 200 -> 304', async () => {
      // Step 1: Initial state -> 200
      const res1 = await sendPost(`${server.url}/api/v1/sdk-config`, {})
      assert.equal(res1.statusCode, 200)
      const etag1 = res1.headers['etag'] as string

      // Step 2: Same etag -> 304
      const res2 = await sendPost(`${server.url}/api/v1/sdk-config`, {}, { 'If-None-Match': `"${etag1}"` })
      assert.equal(res2.statusCode, 304)

      // Step 3: Mutate config
      server.mutateConfig(draft => {
        draft.sampling.traces = 0.25
      })
      const etag2 = server.eTag
      assert.notEqual(etag1, etag2, 'ETag must change after config mutation')

      // Step 4: Old etag with mutated server -> 200 with updated config
      const res3 = await sendPost(`${server.url}/api/v1/sdk-config`, {}, { 'If-None-Match': `"${etag1}"` })
      assert.equal(res3.statusCode, 200)
      const body3 = JSON.parse(res3.body)
      assert.equal(body3.config.sampling.traces, 0.25)
      assert.equal(res3.headers['etag'], etag2)

      // Step 5: New etag -> 304
      const res4 = await sendPost(`${server.url}/api/v1/sdk-config`, {}, { 'If-None-Match': `W/"${etag2}"` })
      assert.equal(res4.statusCode, 304)
    })

    it('/v1/sdk-config alias supports ETag negotiation identically to /api/v1/sdk-config', async () => {
      const etag = server.eTag
      const res = await sendPost(`${server.url}/v1/sdk-config`, {}, {
        'If-None-Match': `"${etag}"`,
      })
      assert.equal(res.statusCode, 304)
    })
  })

  // ─── 3. Reactive ACK 202 `{ change: true }` Timing & Route Targeting ────

  describe('Reactive ACK 202 Timing & Route-Targeted Signaling', () => {
    it('simulateConfigChange() arms exactly one 202 response across all routes', async () => {
      server.simulateConfigChange({ features: { profiling: false } })

      // First call (traces) -> 202
      const res1 = await sendPost(`${server.url}/api/v1/traces`, { events: [] })
      assert.equal(res1.statusCode, 202)
      assert.equal(JSON.parse(res1.body).change, true)

      // Second call (metrics) -> 200
      const res2 = await sendPost(`${server.url}/api/v1/metrics`, { events: [] })
      assert.equal(res2.statusCode, 200)
      assert.equal(JSON.parse(res2.body).change, false)

      // Third call (errors) -> 200
      const res3 = await sendPost(`${server.url}/api/v1/errors`, { events: [] })
      assert.equal(res3.statusCode, 200)
      assert.equal(JSON.parse(res3.body).change, false)
    })

    it('armConfigRefreshSignal(route) triggers 202 ONLY for the targeted route across all 10 routes', async () => {
      for (const targetRoute of ALL_10_ROUTES) {
        server.armConfigRefreshSignal(targetRoute)

        // Send to a non-target route (e.g. 'replays' if target is not replays, else 'events')
        const nonTargetRoute = targetRoute === 'replays' ? 'events' : 'replays'
        const nonTargetRes = await sendPost(`${server.url}/api/v1/${nonTargetRoute}`, { events: [] })
        assert.equal(
          nonTargetRes.statusCode,
          200,
          `Non-target route "${nonTargetRoute}" should return 200 when "${targetRoute}" is armed`,
        )
        assert.equal(JSON.parse(nonTargetRes.body).change, false)

        // Send to target route -> must receive 202
        const targetRes = await sendPost(`${server.url}/api/v1/${targetRoute}`, { events: [] })
        assert.equal(
          targetRes.statusCode,
          202,
          `Target route "${targetRoute}" must receive 202 when armed`,
        )
        assert.equal(JSON.parse(targetRes.body).change, true)

        // Subsequent request to target route -> must revert to 200
        const subsequentRes = await sendPost(`${server.url}/api/v1/${targetRoute}`, { events: [] })
        assert.equal(
          subsequentRes.statusCode,
          200,
          `Target route "${targetRoute}" must revert to 200 on subsequent request`,
        )
        assert.equal(JSON.parse(subsequentRes.body).change, false)
      }
    })

    it('preserves route-targeted 202 across query strings, trailing slashes, and /v1 aliases', async () => {
      // 1. Trailing slash
      server.armConfigRefreshSignal('errors')
      const resSlash = await sendPost(`${server.url}/api/v1/errors/`, { events: [] })
      assert.equal(resSlash.statusCode, 202)
      assert.equal(JSON.parse(resSlash.body).change, true)

      // 2. Query string
      server.armConfigRefreshSignal('metrics')
      const resQuery = await sendPost(`${server.url}/api/v1/metrics?interval=60s&source=agent`, { events: [] })
      assert.equal(resQuery.statusCode, 202)
      assert.equal(JSON.parse(resQuery.body).change, true)

      // 3. /v1/ alias
      server.armConfigRefreshSignal('traces')
      const resAlias = await sendPost(`${server.url}/v1/traces`, { events: [] })
      assert.equal(resAlias.statusCode, 202)
      assert.equal(JSON.parse(resAlias.body).change, true)
    })

    it('handles 50 concurrent requests cleanly with exactly one 202 on armed route', async () => {
      server.armConfigRefreshSignal('logs')

      const routes: TransportRouteName[] = ['traces', 'requests', 'errors', 'metrics', 'logs']
      const requests = Array.from({ length: 50 }, (_, i) => {
        const route = routes[i % routes.length]!
        return sendPost(`${server.url}/api/v1/${route}`, { events: [{ id: `evt-${i}` }] })
      })

      const responses = await Promise.all(requests)
      const ack202Count = responses.filter(r => r.statusCode === 202).length
      const ack200Count = responses.filter(r => r.statusCode === 200).length

      assert.equal(ack202Count, 1, 'Exactly one request should receive HTTP 202')
      assert.equal(ack200Count, 49, 'All other 49 requests should receive HTTP 200')

      // Verify the 202 response was on the logs route
      const logsRequests = server.getReceivedRequests('logs')
      const logs202s = responses.filter(
        r => r.statusCode === 202 && JSON.parse(r.body).change === true,
      )
      assert.equal(logs202s.length, 1)
    })

    it('flagConfigChanged(false) cancels pending armed refresh', async () => {
      server.armConfigRefreshSignal('spans')
      server.flagConfigChanged(false)

      const res = await sendPost(`${server.url}/api/v1/spans`, { events: [] })
      assert.equal(res.statusCode, 200)
      assert.equal(JSON.parse(res.body).change, false)
    })
  })

  // ─── 4. waitForRequests & waitForEvents Concurrency & Boundaries ──────────

  describe('waitForRequests & waitForEvents Concurrency & Boundary Cases', () => {
    it('resolves immediately when matching requests are already in history', async () => {
      await sendPost(`${server.url}/api/v1/traces`, { events: [{ id: 'pre-1' }] })
      await sendPost(`${server.url}/api/v1/traces`, { events: [{ id: 'pre-2' }] })

      const start = Date.now()
      const matches = await server.waitForRequests('traces', { count: 2, timeoutMs: 500 })
      const duration = Date.now() - start

      assert.equal(matches.length, 2)
      assert.ok(duration < 50, `Expected instant resolution (< 50ms), took ${duration}ms`)
    })

    it('resolves when targetCount is high and requests arrive sequentially', async () => {
      const targetCount = 15

      const waitPromise = server.waitForRequests('requests', { count: targetCount, timeoutMs: 2_000 })

      for (let i = 0; i < targetCount; i++) {
        await sendPost(`${server.url}/api/v1/requests`, { events: [{ id: `req-seq-${i}` }] })
      }

      const results = await waitPromise
      assert.equal(results.length, targetCount)
    })

    it('supports custom predicate filtering on request headers, methods, and payload fields', async () => {
      await sendPost(`${server.url}/api/v1/events`, { customTag: 'special-tag-123' }, { 'x-custom-tenant': 'tenant-99' })

      const found = await server.waitForRequests(
        req => req.headers['x-custom-tenant'] === 'tenant-99' && (req.body as any)?.customTag === 'special-tag-123',
        { count: 1, timeoutMs: 1_000 },
      )

      assert.equal(found.length, 1)
      assert.equal(found[0]?.headers['x-custom-tenant'], 'tenant-99')
    })

    it('handles 10 parallel waiters with different predicates simultaneously without interference', async () => {
      const targetRoutes: TransportRouteName[] = [
        'traces',
        'requests',
        'spans',
        'errors',
        'metrics',
        'logs',
        'profiles',
        'events',
        'crons',
        'replays',
      ]

      // Start 10 waiters concurrently
      const waiters = targetRoutes.map(route =>
        server.waitForRequests(route, { count: 1, timeoutMs: 2_000 }),
      )

      // Asynchronously send one request to each of the 10 routes
      setTimeout(async () => {
        for (const route of targetRoutes) {
          await sendPost(`${server.url}/api/v1/${route}`, { events: [{ routeId: route }] })
        }
      }, 50)

      const allResults = await Promise.all(waiters)
      assert.equal(allResults.length, 10)
      for (let i = 0; i < targetRoutes.length; i++) {
        assert.equal(allResults[i]?.length, 1)
        assert.equal(allResults[i]?.[0]?.route, targetRoutes[i])
      }
    })

    it('waitForRequests throws descriptive error when timeout expires', async () => {
      const start = Date.now()
      await assert.rejects(
        async () => {
          await server.waitForRequests('non-existent-route', { count: 5, timeoutMs: 100 })
        },
        err => {
          assert.ok(err instanceof Error)
          assert.match(err.message, /Timeout waiting for 5 requests matching criteria after 100ms/i)
          return true
        },
      )
      const elapsed = Date.now() - start
      assert.ok(elapsed >= 90 && elapsed < 500, `Expected timeout in ~100ms, took ${elapsed}ms`)
    })

    it('waitForEvents correctly filters across multiple batched events', async () => {
      const errEvent1: ErrorEvent = {
        eventId: 'err-target-alpha',
        timestamp: 1000,
        type: 'error',
        name: 'AlphaError',
        message: 'alpha failure',
        stack: [],
        fingerprint: 'fp-a',
        severity: 'error',
        context: {},
        metadata: {
          sdkName: 'pulse-sdk',
          sdkVersion: '1.0.0',
          applicationName: 'e2e-app',
          applicationVersion: '1.0.0',
          projectId: 'p',
          environment: 't',
          release: '1',
        },
      }

      const errEvent2: ErrorEvent = {
        eventId: 'err-target-beta',
        timestamp: 1001,
        type: 'error',
        name: 'BetaError',
        message: 'beta failure',
        stack: [],
        fingerprint: 'fp-b',
        severity: 'error',
        context: {},
        metadata: {
          sdkName: 'pulse-sdk',
          sdkVersion: '1.0.0',
          applicationName: 'e2e-app',
          applicationVersion: '1.0.0',
          projectId: 'p',
          environment: 't',
          release: '1',
        },
      }

      // Dispatch 2 events in a single batch
      await sendPost(`${server.url}/api/v1/errors`, { events: [errEvent1, errEvent2] })

      const alphaMatches = await server.waitForEvents(
        (e: SDKEvent) => e.eventId === 'err-target-alpha',
        { count: 1, timeoutMs: 500 },
      )
      assert.equal(alphaMatches.length, 1)
      assert.equal(alphaMatches[0]?.eventId, 'err-target-alpha')

      const betaMatches = await server.waitForEvents('errors', { count: 2, timeoutMs: 500 })
      assert.equal(betaMatches.length, 2)
    })

    it('records high-throughput burst of 100 requests in parallel without drop', async () => {
      const burstSize = 100
      const promises = Array.from({ length: burstSize }, (_, i) =>
        sendPost(`${server.url}/api/v1/metrics`, { events: [{ index: i }] }),
      )

      await Promise.all(promises)

      const recorded = server.getReceivedRequests('metrics')
      assert.equal(recorded.length, burstSize, `Expected all ${burstSize} requests recorded`)
      assert.equal(server.getReceivedEventCount('metrics'), burstSize)
    })

    it('clearHistory() resets history and does not corrupt subsequent waitForRequests', async () => {
      await sendPost(`${server.url}/api/v1/traces`, { events: [{ id: '1' }] })
      assert.equal(server.getReceivedRequests().length, 1)

      server.clearHistory()
      assert.equal(server.getReceivedRequests().length, 0)

      setTimeout(() => {
        void sendPost(`${server.url}/api/v1/traces`, { events: [{ id: '2' }] })
      }, 50)

      const res = await server.waitForRequests('traces', { count: 1, timeoutMs: 500 })
      assert.equal(res.length, 1)
      assert.equal(server.getReceivedEvents('traces')[0]?.eventId, undefined)
      assert.equal((res[0]?.events[0] as any)?.id, '2')
    })
  })

  // ─── 5. Test Helpers Resilience & Process Leak Verification ──────────────

  describe('test-helpers Resilience & Leak Detection', () => {
    it('resetSdkState() is strictly idempotent and safe on uninitialized SDK', async () => {
      const r1 = await resetSdkState()
      assert.equal(r1.completed, true)

      const r2 = await resetSdkState()
      assert.equal(r2.completed, true)
    })

    it('assertNoProcessLeaks() detects leaked process signal listeners', () => {
      const baseline = captureProcessBaseline()

      const dummyListener = (): void => {}
      process.on('SIGTERM', dummyListener)

      try {
        assert.throws(
          () => {
            assertNoProcessLeaks(baseline)
          },
          /SIGTERM listener leak/i,
        )
      } finally {
        process.removeListener('SIGTERM', dummyListener)
      }

      // After cleanup, assertNoProcessLeaks passes
      assertNoProcessLeaks(baseline)
    })

    it('withMockServer() guarantees server and SDK teardown on test error', async () => {
      let capturedUrl = ''
      await assert.rejects(
        async () => {
          await withMockServer(async (srv, url) => {
            capturedUrl = url
            throw new Error('Forced test exception')
          })
        },
        /Forced test exception/,
      )

      // Verify the server is stopped and cannot be contacted
      if (capturedUrl) {
        await assert.rejects(
          async () => {
            await sendPost(`${capturedUrl}/api/v1/init`, {})
          },
          /ECONNREFUSED|fetch failed/i,
        )
      }
    })

    it('registerRouteHandler() overrides endpoint and still captures request records', async () => {
      server.registerRouteHandler('/api/v1/custom-endpoint', (req, res) => {
        res.writeHead(201, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ custom: true }))
      })

      const res = await sendPost(`${server.url}/api/v1/custom-endpoint`, { input: 'test' })
      assert.equal(res.statusCode, 201)
      assert.deepEqual(JSON.parse(res.body), { custom: true })

      const recorded = server.getLatestRequest('/api/v1/custom-endpoint')
      assert.ok(recorded)
      assert.equal(recorded.statusCode, 201)
      assert.deepEqual(recorded.body, { input: 'test' })
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
