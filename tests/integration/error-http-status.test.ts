import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import Fastify from 'fastify'
import { gunzipSync } from 'node:zlib'
import http from 'node:http'

process.env.DEBUG = 'pulse*'
import { init } from '../../src/core/init.js'
import { shutdown, flush } from '../../src/core/lifecycle.js'
import { captureError } from '../../src/capture/captureError.js'
import { client } from '../../src/core/client.js'
import { monitorMiddleware } from '../../src/instrumentation/express.js'
import { fastifyPulsePlugin } from '../../src/instrumentation/fastify.js'
import { createContextStore, withContext } from '../../src/core/context.js'
import { TEST_REMOTE_CONFIG as BAKED_IN_REMOTE_CONFIG } from '../fixtures/remote-config.js'

// ─── Mock Backend ───────────────────────────────────────────────────────────

interface MockServer {
  url: string
  requests: Array<{ path: string; body: unknown }>
  reset(): void
  close(): Promise<void>
}

async function startMockBackend(): Promise<MockServer> {
  const requests: Array<{ path: string; body: unknown }> = []

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => {
      chunks.push(Buffer.from(chunk))
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks)
      const decoded = req.headers['content-encoding'] === 'gzip' ? gunzipSync(raw).toString('utf8') : raw.toString('utf8')
      try {
        const body = decoded ? JSON.parse(decoded) : null
        requests.push({ path: req.url ?? '', body })
      } catch {
        requests.push({ path: req.url ?? '', body: decoded })
      }

      if (req.url === '/v1/init' || req.url === '/api/v1/init') {
        const port = (server.address() as { port: number }).port
        const localUrl = `http://127.0.0.1:${port}`
        const paths: Record<string, string> = {
          errors: '/api/v1/errors',
          events: '/api/v1/events',
          requests: '/api/v1/requests',
          traces: '/api/v1/traces',
          spans: '/api/v1/spans',
          metrics: '/api/v1/metrics',
          logs: '/api/v1/logs',
          profiles: '/api/v1/profiles',
          crons: '/api/v1/checkins',
          replays: '/api/v1/replays',
        }
        const routes = Object.fromEntries(Object.entries(BAKED_IN_REMOTE_CONFIG.transport.routes).map(([name, route]) => [
          name,
          { ...route, url: `${localUrl}${paths[name] || '/api/v1/unknown'}`, batchSize: 1, flushIntervalMs: 50, timeoutMs: 2_000 },
        ]))
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            success: true,
            projectId: 'proj-test',
            environment: 'test',
            release: '1.0.0',
            config: {
              ...BAKED_IN_REMOTE_CONFIG,
              sdk: { projectId: 'proj-test', service: 'lifecycle-test', environment: 'test', release: '1.0.0' },
              features: { ...BAKED_IN_REMOTE_CONFIG.features, tracing: true, requestCapture: true, errors: true, metrics: true },
              sampling: { ...BAKED_IN_REMOTE_CONFIG.sampling, traces: 1, requests: 1, errors: 1, metrics: 1 },
              killswitches: { ...BAKED_IN_REMOTE_CONFIG.killswitches, disableTransport: false },
              transport: { ...BAKED_IN_REMOTE_CONFIG.transport, routes },
              entitlements: { ...BAKED_IN_REMOTE_CONFIG.entitlements, errors: true, tracing: true, requestCapture: true, customSpans: true },
            },
          })
        )
        return
      }

      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    })
  })

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    reset() {
      requests.length = 0
    },
    async close() {
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}

// ─── Test Helpers ───────────────────────────────────────────────────────────

function getErrorEvents(backend: MockServer): any[] {
  // Debug output
  console.log('All paths hit:', backend.requests.map(r => r.path))
  
  // They might be sent to /api/v1/events and wrapped in an { events: [...] } array
  const eventsRoute = backend.requests.filter(req => req.path === '/api/v1/events')
  const errorsRoute = backend.requests.filter(req => req.path === '/api/v1/errors')
  
  const allEvents = []
  
  for (const req of eventsRoute) {
    if (req.body && (req.body as any).events) {
       allEvents.push(...(req.body as any).events)
    }
  }
  
  for (const req of errorsRoute) {
    if (req.body && (req.body as any).events) {
       allEvents.push(...(req.body as any).events)
    }
  }
  
  return allEvents
}

function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function makeRequest(url: string, method: string = 'GET'): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method }, res => {
      res.resume()
      resolve(res.statusCode || 0)
    })
    req.on('error', reject)
    req.end()
  })
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('HTTP Status Enrichment', { timeout: 30_000 }, () => {
  let backend: MockServer

  before(async () => {
    backend = await startMockBackend()
    await init({
      apiKey: 'test-key',
      debug: false,
    })
    console.log('SDK Init result. client.initialized:', client.initialized)
  })

  after(async () => {
    await shutdown(5_000)
    await backend.close()
  })

  describe('Express Integration', () => {
    let app: express.Express
    let server: http.Server
    let baseUrl: string

    before(async () => {
      app = express()
      app.use(monitorMiddleware())

      app.get('/test-500', (req, res, next) => {
        next(new Error('Express 500 error'))
      })

      app.get('/test-400', (req, res, next) => {
        res.status(400)
        console.error(new Error('Express 400 error ' + Date.now()))
        res.send('Error 400')
      })

      app.get('/test-403', (req, res, next) => {
        res.status(403)
        console.error(new Error('Express 403 error ' + Date.now()))
        res.send('Error 403')
      })

      // Removed custom error handler so Express uses the default error handler.
      // The default error handler calls console.error, which the SDK patches
      // to capture the error automatically.

      await new Promise<void>(resolve => {
        server = app.listen(0, '127.0.0.1', () => resolve())
      })
      baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    })

    after(async () => {
      await new Promise<void>(resolve => server.close(() => resolve()))
    })

    it('Express 500 error includes statusCode', async () => {
      backend.reset()
      await makeRequest(`${baseUrl}/test-500`)
      await delay(200)
      await flush()

      const events = getErrorEvents(backend)
      console.log('[DEBUG] Express 500 events received:', events.map(e => e.message))
      const ev = events.find(e => e.message?.includes('Express 500 error'))
      assert.ok(ev, 'Event should be captured')
      assert.equal(ev.handled, true)
      assert.equal(ev.method, 'GET')
      assert.equal(ev.url, '/test-500')
      assert.equal(ev.statusCode, 500)
    })

    it('Express 403 error (if we manually throw 403)', async () => {
      backend.reset()
      await makeRequest(`${baseUrl}/test-403`)
      await delay(200)
      await flush()

      const events = getErrorEvents(backend)
      console.log('[DEBUG] Express 403 events received:', events.map(e => e.message))
      const ev = events.find(e => e.message?.includes('Express 403 error'))
      assert.ok(ev, 'Event should be captured')
      assert.equal(ev.handled, true)
      assert.equal(ev.statusCode, 403)
    })

  })

  describe('Fastify Integration', () => {
    let app: ReturnType<typeof Fastify>
    let baseUrl: string

    before(async () => {
      app = Fastify()
      
      // Make the plugin global for the test by simulating fastify-plugin
      ;(fastifyPulsePlugin as any)[Symbol.for('skip-override')] = true
      await app.register(fastifyPulsePlugin, {})

      app.get('/test-500', async () => {
        throw new Error('Fastify 500 error')
      })

      app.get('/test-422', async (request: any, reply: any) => {
        reply.status(422)
        throw new Error('Fastify 422 error')
      })

      app.get('/test-401', async (request: any, reply: any) => {
        reply.status(401)
        throw new Error('Fastify 401 error')
      })

      await app.listen({ port: 0, host: '127.0.0.1' })
      baseUrl = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`
    })

    after(async () => {
      await app.close()
    })

    it('Fastify 500 error includes statusCode', async () => {
      backend.reset()
      await makeRequest(`${baseUrl}/test-500`)
      await delay(200)
      await flush()

      const events = getErrorEvents(backend)
      const ev = events.find(e => e.message?.includes('Fastify 500 error'))
      assert.ok(ev, 'Event should be captured')
      assert.equal(ev.handled, true)
      assert.equal(ev.method, 'GET')
      assert.equal(ev.url, '/test-500')
      assert.equal(ev.statusCode, 500)
    })

    it('Fastify 422 error includes statusCode', async () => {
      backend.reset()
      await makeRequest(`${baseUrl}/test-422`)
      await delay(200)
      await flush()

      const events = getErrorEvents(backend)
      const ev = events.find(e => e.message?.includes('Fastify 422 error'))
      assert.ok(ev, 'Event should be captured')
      assert.equal(ev.handled, true)
      assert.equal(ev.statusCode, 422)
    })

    it('Fastify 401 error includes statusCode', async () => {
      backend.reset()
      await makeRequest(`${baseUrl}/test-401`)
      await delay(200)
      await flush()

      const events = getErrorEvents(backend)
      const ev = events.find(e => e.message?.includes('Fastify 401 error'))
      assert.ok(ev, 'Event should be captured')
      assert.equal(ev.handled, true)
      assert.equal(ev.statusCode, 401)
    })
  })

  describe('Non-HTTP Contexts and Manual captures', () => {
    it('Manual captureError() handles true, no HTTP status', async () => {
      backend.reset()
      captureError(new Error('Manual error'))
      await delay(200)
      await flush()

      const events = getErrorEvents(backend)
      const ev = events.find(e => e.message === 'Manual error')
      assert.ok(ev, 'Event should be captured')
      assert.equal(ev.handled, true)
      assert.equal(ev.statusCode, undefined)
      assert.equal(ev.method, undefined)
      assert.equal(ev.url, undefined)
    })

    it('uncaughtException handles false, no HTTP status', async () => {
      backend.reset()
      captureError(new Error('Uncaught error'), 'fatal')
      await delay(200)
      await flush()

      const events = getErrorEvents(backend)
      const ev = events.find(e => e.message === 'Uncaught error')
      assert.ok(ev, 'Event should be captured')
      assert.equal(ev.statusCode, undefined)
    })

    it('unhandledRejection handles false, no HTTP status', async () => {
      backend.reset()
      const store = createContextStore('unhandled', 10, {
        extra: { mechanism: 'unhandledRejection', handled: false },
      })
      withContext(store, () => {
        captureError(new Error('Unhandled rejection'), 'error')
      })
      await delay(50)
      await flush()

      const events = getErrorEvents(backend)
      const ev = events.find(e => e.message === 'Unhandled rejection')
      assert.ok(ev, 'Event should be captured')
      assert.equal(ev.handled, false)
      assert.equal(ev.statusCode, undefined)
    })
  })
})
