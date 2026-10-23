import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import http from 'node:http'
import {
  init,
  shutdown,
  lynktraceMiddleware,
  instrumentExpress,
} from '../../src/index.js'
import { TEST_REMOTE_CONFIG } from '../fixtures/remote-config.js'

const originalFetch = globalThis.fetch

function setupMockFetch() {
  globalThis.fetch = (async (url: any) => {
    if (String(url).includes('/v1/init')) {
      return new Response(
        JSON.stringify({
          success: true,
          projectId: 'test-project',
          environment: 'test',
          release: '1.0.0',
          config: {
            ...TEST_REMOTE_CONFIG,
            features: {
              ...TEST_REMOTE_CONFIG.features,
              tracing: true,
              requestCapture: true,
            },
            sampling: {
              ...TEST_REMOTE_CONFIG.sampling,
              traces: 1,
              spans: 1,
              requests: 1,
            },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  }) as any
}

function makeRequest(server: http.Server, path: string): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const addr = server.address()
    if (!addr || typeof addr === 'string') {
      return reject(new Error('Server address unavailable'))
    }
    const req = http.get(`http://127.0.0.1:${addr.port}${path}`, (res) => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        resolve({ statusCode: res.statusCode ?? 0, body: data })
      })
    })
    req.on('error', reject)
  })
}

describe('Express Middleware Layer Timing & Threshold Instrumentation', () => {
  beforeEach(async () => {
    setupMockFetch()
    await init({ apiKey: 'test-key' })
  })

  afterEach(async () => {
    globalThis.fetch = originalFetch
    await shutdown()
  })

  it('instruments Express middleware execution and emits spans for slow layers', async () => {
    const app = express()

    // Fast middleware (takes <1ms)
    function fastHeader(req: any, res: any, next: any) {
      res.setHeader('X-Pulse-Test', 'fast')
      next()
    }

    // Slow middleware (e.g. simulated password hashing taking 10ms)
    function slowAuth(req: any, res: any, next: any) {
      setTimeout(() => {
        req.user = { id: 'usr_123' }
        next()
      }, 10)
    }

    app.use(lynktraceMiddleware({
      instrumentMiddleware: true,
      minMiddlewareDurationMs: 2,
    }))
    app.use(fastHeader)
    app.use(slowAuth)

    app.get('/api/test', (req, res) => {
      res.json({ ok: true, user: (req as any).user })
    })

    const server = http.createServer(app)
    await new Promise<void>((resolve) => server.listen(0, resolve))

    try {
      const response = await makeRequest(server, '/api/test')
      assert.equal(response.statusCode, 200)
      const parsed = JSON.parse(response.body)
      assert.equal(parsed.ok, true)
      assert.equal(parsed.user?.id, 'usr_123')
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('captures middleware errors and records exception details', async () => {
    const app = express()

    function failingAuth(req: any, res: any, next: any) {
      next(new Error('Invalid bearer token'))
    }

    app.use(lynktraceMiddleware({
      instrumentMiddleware: true,
      minMiddlewareDurationMs: 1,
    }))
    app.use(failingAuth)

    app.use((err: any, req: any, res: any, next: any) => {
      res.status(401).json({ error: err.message })
    })

    const server = http.createServer(app)
    await new Promise<void>((resolve) => server.listen(0, resolve))

    try {
      const response = await makeRequest(server, '/api/secure')
      assert.equal(response.statusCode, 401)
      const parsed = JSON.parse(response.body)
      assert.equal(parsed.error, 'Invalid bearer token')
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('respects ignoreMiddlewares list and programmatic instrumentExpress', async () => {
    const app = express()

    instrumentExpress(app, {
      minMiddlewareDurationMs: 2,
      ignoreMiddlewares: ['ignoredSlow'],
    })

    function ignoredSlow(req: any, res: any, next: any) {
      setTimeout(next, 5)
    }

    app.use(lynktraceMiddleware())
    app.use(ignoredSlow)
    app.get('/api/ignored', (req, res) => res.json({ ignored: true }))

    const server = http.createServer(app)
    await new Promise<void>((resolve) => server.listen(0, resolve))

    try {
      const response = await makeRequest(server, '/api/ignored')
      assert.equal(response.statusCode, 200)
      assert.equal(JSON.parse(response.body).ignored, true)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('instruments middlewares by default when lynktraceMiddleware is called without arguments', async () => {
    const app = express()

    function customMiddleware(req: any, res: any, next: any) {
      setTimeout(() => {
        req.processedByDefault = true
        next()
      }, 5)
    }

    // Default: no options passed -> should profile middlewares >= 2ms
    app.use(lynktraceMiddleware())
    app.use(customMiddleware)
    app.get('/api/default-timing', (req, res) => {
      res.json({ processed: (req as any).processedByDefault })
    })

    const server = http.createServer(app)
    await new Promise<void>((resolve) => server.listen(0, resolve))

    try {
      const response = await makeRequest(server, '/api/default-timing')
      assert.equal(response.statusCode, 200)
      assert.equal(JSON.parse(response.body).processed, true)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('allows opting out of middleware profiling with instrumentMiddleware: false', async () => {
    const app = express()

    function customMiddleware(req: any, res: any, next: any) {
      setTimeout(() => {
        req.processedWithoutTiming = true
        next()
      }, 5)
    }

    // Explicit opt-out
    app.use(lynktraceMiddleware({ instrumentMiddleware: false }))
    app.use(customMiddleware)
    app.get('/api/opt-out', (req, res) => {
      res.json({ processed: (req as any).processedWithoutTiming })
    })

    const server = http.createServer(app)
    await new Promise<void>((resolve) => server.listen(0, resolve))

    try {
      const response = await makeRequest(server, '/api/opt-out')
      assert.equal(response.statusCode, 200)
      assert.equal(JSON.parse(response.body).processed, true)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
