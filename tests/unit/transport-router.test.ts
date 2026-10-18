import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { gunzipSync } from 'node:zlib'
import { TEST_REMOTE_CONFIG as BAKED_IN_REMOTE_CONFIG } from '../fixtures/remote-config.js'
import { TransportRouter } from '../../src/transport/transport-router.js'
import type { SDKEvent } from '../../src/types/event.js'
import type { TransportRemoteConfig } from '../../src/types/config.js'

// Parse either backend-configured gzip or uncompressed JSON batches.
function parseBody(body: unknown): any {
  const buf = typeof body === 'string' ? Buffer.from(body, 'utf8') : Buffer.from(body as Uint8Array)
  const isGzip = buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b
  return JSON.parse((isGzip ? gunzipSync(buf) : buf).toString('utf8'))
}

function config(base = 'https://collector.example.test'): TransportRemoteConfig {
  const existing = BAKED_IN_REMOTE_CONFIG.transport
  // v3 schema: top-level `routes` (was `endpoints`), retry/queue/keepAlive
  // hoisted out of the old `shared` block.
  return {
    ...existing,
    routes: {
      ...existing.routes,
      errors:   { ...existing.routes.errors,   url: `${base}/custom-errors` },
      events:   { ...existing.routes.events,   url: `${base}/custom-events` },
      traces:   { ...existing.routes.traces,   url: `${base}/custom-traces` },
      spans:    { ...existing.routes.spans,    url: `${base}/custom-spans` },
      requests: { ...existing.routes.requests, url: `${base}/custom-requests` },
      metrics:  { ...existing.routes.metrics,  url: `${base}/custom-metrics` },
      logs:     { ...existing.routes.logs,     url: `${base}/custom-logs` },
      profiles: { ...existing.routes.profiles, url: `${base}/custom-profiles` },
      crons:    { ...existing.routes.crons,    url: `${base}/custom-crons` },
    },
  }
}

function event(type: SDKEvent['type'], index: number): SDKEvent {
  switch (type) {
    case 'error':
      return {
        type,
        eventId: `err-${index}`,
        message: 'boom',
        name: 'Error',
        stack: [],
        fingerprint: `fp-${index}`,
        timestamp: Date.now(),
        severity: 'error',
        context: {},
        classification: { unhandled: false, fatal: false, crash: false },
      }
    case 'span':
      return {
        type,
        eventId: `span-${index}`,
        spanId: `span${index}`,
        traceId: `trace${index}`,
        name: 'op',
        startTime: Date.now(),
        endTime: Date.now() + 1,
        duration: 1,
        status: 'ok',
      }
    case 'request':
      return {
        type,
        eventId: `req-${index}`,
        requestId: `req-${index}`,
        url: '/orders',
        method: 'GET',
        statusCode: 200,
        latency: 1,
        timestamp: Date.now(),
      }
    case 'metric':
      return {
        type,
        eventId: `metric-${index}`,
        metricName: 'http.server.duration',
        metricType: 'histogram',
        value: index,
        timestamp: Date.now(),
      }
    case 'log':
      return {
        type,
        eventId: `log-${index}`,
        level: 'info',
        message: `log ${index}`,
        timestamp: Date.now(),
      }
    default:
      return {
        type: 'message',
        eventId: `msg-${index}`,
        message: 'message',
        severity: 'info',
        timestamp: Date.now(),
      }
  }
}

function okResponse(): Response {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

describe('Unified TransportRouter', () => {
  afterEach(async () => {
    await TransportRouter.getInstance()?.shutdown()
  })

  it('routes event types to deterministic endpoints', async () => {
    const calls: Array<{ url: string; body: any }> = []
    const fetchImpl: typeof fetch = async (url, options) => {
      calls.push({ url: String(url), body: parseBody(options?.body) })
      return okResponse()
    }

    const router = await TransportRouter.initialize(config(), 'test-key', fetchImpl, BAKED_IN_REMOTE_CONFIG.limits)
    router.send(event('error', 1))
    router.send(event('message', 1))
    router.send(event('span', 1))
    router.send(event('request', 1))
    router.send(event('metric', 1))
    await router.flushAll()

    const urls = calls.map(call => new URL(call.url).pathname)
    assert.ok(urls.includes('/custom-errors'))
    assert.ok(urls.includes('/custom-events'))
    assert.ok(urls.includes('/custom-spans'))
    assert.ok(urls.includes('/custom-metrics'))

    // v3 routing: message, span and request events each have dedicated routes.
    const eventCall = calls.find(call => new URL(call.url).pathname === '/custom-events')
    assert.deepEqual(eventCall?.body.events.map((e: any) => e.type).sort(), ['message'])
    const spanCall = calls.find(call => new URL(call.url).pathname === '/custom-spans')
    assert.deepEqual(spanCall?.body.events.map((e: any) => e.type).sort(), ['span'])
    const requestCall = calls.find(call => new URL(call.url).pathname === '/custom-requests')
    assert.deepEqual(requestCall?.body.events.map((e: any) => e.type).sort(), ['request'])
  })

  it('hard-enforces per-route and global in-flight connection limits', async () => {
    const active = { errors: 0, spans: 0, metrics: 0 }
    const maxActive = { errors: 0, spans: 0, metrics: 0, total: 0 }

    const fetchImpl: typeof fetch = async (url) => {
      const path = new URL(String(url)).pathname
      const route = path.includes('errors') ? 'errors' : path.includes('spans') ? 'spans' : 'metrics'
      active[route]++
      maxActive[route] = Math.max(maxActive[route], active[route])
      maxActive.total = Math.max(maxActive.total, active.errors + active.spans + active.metrics)
      await new Promise(resolve => setTimeout(resolve, 25))
      active[route]--
      return okResponse()
    }

    const router = await TransportRouter.initialize(config(), 'test-key', fetchImpl, BAKED_IN_REMOTE_CONFIG.limits)
    for (let i = 0; i < 3_000; i++) router.send(event('error', i))
    for (let i = 0; i < 10_000; i++) router.send(event('span', i))
    for (let i = 0; i < 10_000; i++) router.send(event('metric', i))
    await router.flushAll()

    assert.ok(maxActive.errors <= 30, `errors exceeded limit: ${maxActive.errors}`)
    assert.ok(maxActive.spans <= 50, `spans exceeded limit: ${maxActive.spans}`)
    assert.ok(maxActive.metrics <= 20, `metrics exceeded limit: ${maxActive.metrics}`)
    assert.ok(maxActive.total <= 100, `global exceeded limit: ${maxActive.total}`)
  })

  it('keeps error delivery isolated while spans are backlogged', async () => {
    let firstErrorAt = 0
    const startedAt = Date.now()
    const fetchImpl: typeof fetch = async (url) => {
      const path = new URL(String(url)).pathname
      if (path === '/custom-spans') {
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      if (path === '/custom-errors' && firstErrorAt === 0) {
        firstErrorAt = Date.now()
      }
      return okResponse()
    }

    const router = await TransportRouter.initialize(config(), 'test-key', fetchImpl, BAKED_IN_REMOTE_CONFIG.limits)
    for (let i = 0; i < 76_000; i++) router.send(event('span', i))
    for (let i = 0; i < 100; i++) router.send(event('error', i))
    await router.flushAll()

    const debug = router.getDebugState()
    assert.ok(firstErrorAt > 0)
    assert.ok(firstErrorAt - startedAt < 5_000, `error delivery took ${firstErrorAt - startedAt}ms`)
    assert.ok(debug.droppedEvents.some((drop) => drop.route === 'spans' && drop.reason === 'queue_full'))
  })

  it('warms up route concurrency before sending a full transport burst', async () => {
    let activeLogs = 0
    let maxActiveLogs = 0
    const fetchImpl: typeof fetch = async (url) => {
      if (new URL(String(url)).pathname === '/custom-logs') {
        activeLogs++
        maxActiveLogs = Math.max(maxActiveLogs, activeLogs)
        await new Promise(resolve => setTimeout(resolve, 25))
        activeLogs--
      }
      return okResponse()
    }

    const baseConfig = config()
    const router = await TransportRouter.initialize({
      ...baseConfig,
      connections: {
        ...baseConfig.connections,
        maxConnectionsPerRoute: {
          ...baseConfig.connections.maxConnectionsPerRoute,
          logs: 10,
        },
      },
      routes: {
        ...baseConfig.routes,
        logs: { ...baseConfig.routes.logs, batchSize: 100 },
      },
    }, 'test-key', fetchImpl, BAKED_IN_REMOTE_CONFIG.limits)

    for (let i = 0; i < 700; i++) router.send(event('log', i))
    await router.flushAll()

    assert.equal(router.getHealth().routes.logs?.totalSent, 700)
    assert.ok(maxActiveLogs <= 6, `logs warmed up too aggressively: ${maxActiveLogs}`)
  })

  it('batches steady-state metrics efficiently', async () => {
    let metricRequests = 0
    let metricEvents = 0
    const fetchImpl: typeof fetch = async (url, options) => {
      if (new URL(String(url)).pathname === '/custom-metrics') {
        metricRequests++
        metricEvents += parseBody(options?.body).events.length
      }
      return okResponse()
    }

    const router = await TransportRouter.initialize(config(), 'test-key', fetchImpl, BAKED_IN_REMOTE_CONFIG.limits)
    for (let i = 0; i < 2_000; i++) router.send(event('metric', i))
    await router.flushAll()

    assert.equal(metricEvents, 2_000)
    assert.ok(metricRequests <= 3, `expected efficient batching, got ${metricRequests} requests`)
    assert.ok(metricEvents / metricRequests >= 800)
  })

  it('preserves queued and in-flight events during an atomic transport update', async () => {
    const delivered = new Map<string, number>()
    let releaseOld!: () => void
    let oldStarted!: () => void
    const oldStartedPromise = new Promise<void>(resolve => { oldStarted = resolve })
    const oldGate = new Promise<void>(resolve => { releaseOld = resolve })

    const fetchImpl: typeof fetch = async (url, options) => {
      const payload = parseBody(options?.body)
      if (new URL(String(url)).hostname === 'old.example.test') {
        oldStarted()
        await oldGate
      }
      for (const item of payload.events as SDKEvent[]) {
        delivered.set(item.eventId ?? '', (delivered.get(item.eventId ?? '') ?? 0) + 1)
      }
      return okResponse()
    }

    const oldConfig = config('https://old.example.test')
    const router = await TransportRouter.initialize({
      ...oldConfig,
      routes: { ...oldConfig.routes, errors: { ...oldConfig.routes.errors, batchSize: 1 } },
    }, 'test-key', fetchImpl, BAKED_IN_REMOTE_CONFIG.limits)

    router.send(event('error', 1))
    await oldStartedPromise
    router.send(event('error', 2))
    const updating = router.updateTransport(
      config('https://new.example.test'),
      BAKED_IN_REMOTE_CONFIG.limits,
    )
    await new Promise(resolve => setImmediate(resolve))
    router.send(event('error', 3))
    releaseOld()
    await updating
    await router.flushAll()

    assert.deepEqual([...delivered.entries()].sort(), [['err-1', 1], ['err-2', 1], ['err-3', 1]])
  })
})
