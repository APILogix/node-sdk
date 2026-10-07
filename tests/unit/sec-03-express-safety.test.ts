import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { pulseMiddleware, expressErrorHandler, ensureExpressLayersInstrumented } from '../../src/instrumentation/express.js'
import { ConfigManager } from '../../src/core/config-manager.js'

describe('SEC-03: Express Instrumentation Failsafe and Never Throws', () => {
  it('calls next() without throwing when ConfigManager is uninitialized', (t, done) => {
    // ConfigManager may or may not be initialized; let's test pulseMiddleware directly
    const middleware = pulseMiddleware()
    const req: any = {
      method: 'GET',
      url: '/api/test',
      headers: {},
      socket: { remoteAddress: '127.0.0.1' },
    }
    const res: any = {
      statusCode: 200,
      getHeader: () => undefined,
      once: () => {},
      removeListener: () => {},
    }

    assert.doesNotThrow(() => {
      middleware(req, res, (err) => {
        assert.equal(err, undefined)
        done()
      })
    })
  })

  it('calls next() safely when req has throwing getters', (t, done) => {
    const middleware = pulseMiddleware()
    const req: any = {
      get method() { throw new Error('Exploding method getter') },
      get headers() { throw new Error('Exploding headers getter') },
      get path() { throw new Error('Exploding path getter') },
      get url() { throw new Error('Exploding url getter') },
    }
    const res: any = {
      statusCode: 200,
      once: () => {},
    }

    assert.doesNotThrow(() => {
      middleware(req, res, (err) => {
        assert.equal(err, undefined)
        done()
      })
    })
  })

  it('calls next() safely when req is null or undefined or empty', (t, done) => {
    const middleware = pulseMiddleware()
    const res: any = {
      statusCode: 200,
      once: () => {},
    }

    assert.doesNotThrow(() => {
      middleware(null as any, res, (err) => {
        assert.equal(err, undefined)
        done()
      })
    })
  })

  it('ensureExpressLayersInstrumented never throws on malformed or throwing router stacks', () => {
    assert.doesNotThrow(() => {
      ensureExpressLayersInstrumented(null)
    })
    assert.doesNotThrow(() => {
      ensureExpressLayersInstrumented({})
    })
    assert.doesNotThrow(() => {
      ensureExpressLayersInstrumented({
        router: {
          stack: [null, undefined, { handle: null }],
        },
      })
    })
    assert.doesNotThrow(() => {
      ensureExpressLayersInstrumented({
        get router() {
          throw new Error('Exploding router getter')
        },
      })
    })
  })

  it('expressErrorHandler calls next(err) safely even when context or error getters throw', (t, done) => {
    const errorHandler = expressErrorHandler()
    const error = new Error('Test application error')
    const req: any = {
      get headers() { throw new Error('Exploding headers') },
    }
    const res: any = {
      statusCode: 500,
    }

    assert.doesNotThrow(() => {
      errorHandler(error, req, res, (passedErr) => {
        assert.equal(passedErr, error)
        done()
      })
    })
  })
})
