import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { lynktraceMiddleware } from '../../src/instrumentation/express.js'
import { SecurityScrubber } from '../../src/processors/security-scrubber.js'
import { DEFAULT_PRIVACY } from '../../src/constants/defaults.js'
import { EventEmitter } from 'node:events'

describe('SEC-05: Synchronous PII / Body Processing Event-Loop Safety', () => {
  it('does not block the event loop during request finish callback with a large body', async () => {
    SecurityScrubber.initialize(DEFAULT_PRIVACY)

    const middleware = lynktraceMiddleware()
    assert.strictEqual(typeof middleware, 'function')

    // Create a body with nested objects and sensitive strings
    const largeBody: Record<string, unknown> = {}
    for (let i = 0; i < 50; i++) {
      largeBody[`field_${i}`] = {
        email: `user_${i}@example.com`,
        token: `Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.${i}`,
        message: 'Normal text with card 4532-0151-1283-0366 payment details',
      }
    }

    const req: any = new EventEmitter()
    req.method = 'POST'
    req.url = '/api/checkout'
    req.headers = {
      'content-type': 'application/json',
      authorization: 'Bearer secret_token_12345',
    }
    req.body = largeBody

    const res: any = new EventEmitter()
    res.statusCode = 200
    res.getHeader = (name: string) => (name.toLowerCase() === 'content-length' ? '1024' : undefined)

    let nextCalled = false
    middleware(req, res, () => {
      nextCalled = true
    })
    assert.strictEqual(nextCalled, true)

    // Measure time taken for res.emit('finish') to return
    const start = performance.now()
    res.emit('finish')
    const elapsedMs = performance.now() - start

    // The finish callback must return practically immediately (< 25ms even on slow CI, typically < 1ms)
    assert.ok(elapsedMs < 25, `Finish callback must return immediately, took ${elapsedMs.toFixed(2)}ms`)

    // Wait for the deferred setImmediate turn to complete
    await new Promise(resolve => setImmediate(resolve))
  })
})
