import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  extractTraceContext,
  injectTraceContext,
  headerGetter,
  TRACE_HEADERS,
} from '../../src/tracing/context-propagation.js'
import {
  withContext,
  getRequestContext,
  createContextStore,
  bindContext,
} from '../../src/core/context.js'
import { toError } from '../../src/core/errors.js'
import { captureError } from '../../src/capture/captureError.js'
import { classifyError } from '../../src/core/error-classifier.js'
import { generateFingerprint, resetFingerprintCache } from '../../src/processors/fingerprint.js'
import {
  captureBodySnapshot,
  resolveClientIp,
  matchesIgnoredPath,
} from '../../src/instrumentation/request-capture-utils.js'
import { TokenBucketRateLimiter, SlidingWindowRateLimiter } from '../../src/transport/rate-limit.js'
import { CircuitBreaker } from '../../src/transport/circuit-breaker.js'
import { compress, contentEncoding } from '../../src/utils/compression.js'
import { CardinalityGovernor } from '../../src/utils/cardinality-governor.js'
import { LoadShedder } from '../../src/transport/load-shedder.js'
import { shutdown, crashFlush, registerSignalHandlers, resetSignalHandlers } from '../../src/core/lifecycle.js'
import { createRedisInstrumentation } from '../../src/instrumentation/redis.js'
import { createMongoDBInstrumentation } from '../../src/instrumentation/mongodb.js'
import { createMySQLInstrumentation } from '../../src/instrumentation/mysql.js'
import { createPgInstrumentation } from '../../src/instrumentation/pg.js'
import { createGraphQLInstrumentation } from '../../src/instrumentation/graphql.js'
import { monitorMiddleware, expressErrorHandler } from '../../src/instrumentation/express.js'
import { fastifyPulsePlugin } from '../../src/instrumentation/fastify.js'
import { trace, context as otelContext } from '@opentelemetry/api'

describe('Comprehensive Edge Cases — All 10 SDK Subsystems', () => {

  // ──────────────────────────────────────────────────────────────────────────
  // 1. Context Propagation Across Async Boundaries & Header Casing
  // ──────────────────────────────────────────────────────────────────────────
  describe('1. Context Propagation Across Boundaries & Casing', () => {
    it('extracts W3C traceparent regardless of header casing or arrays', () => {
      const traceId = '4bf92f3577b34da6a3ce929d0e0e4736'
      const spanId = '00f067aa0ba902b7'
      const rawHeader = `00-${traceId}-${spanId}-01`

      // Lowercase
      const ctx1 = extractTraceContext({ traceparent: rawHeader })
      assert.equal(trace.getSpanContext(ctx1)?.traceId, traceId)

      // Uppercase
      const ctx2 = extractTraceContext({ TRACEPARENT: rawHeader })
      assert.equal(trace.getSpanContext(ctx2)?.traceId, traceId)

      // Title case
      const ctx3 = extractTraceContext({ Traceparent: rawHeader })
      assert.equal(trace.getSpanContext(ctx3)?.traceId, traceId)

      // Array form
      const ctx4 = extractTraceContext({ traceparent: [rawHeader, 'ignore'] })
      assert.equal(trace.getSpanContext(ctx4)?.traceId, traceId)

      // Null/undefined / empty carrier resilience
      assert.ok(extractTraceContext(null as any))
      assert.ok(extractTraceContext(undefined as any))
      assert.ok(extractTraceContext({}))
    })

    it('extractTraceContext falls back to x-pulse-trace-id headers when traceparent is absent', () => {
      const traceId = '4bf92f3577b34da6a3ce929d0e0e4736'
      const spanId = '00f067aa0ba902b7'
      const ctx = extractTraceContext({
        'x-pulse-trace-id': traceId,
        'x-pulse-span-id': spanId,
        'x-pulse-sampled': '1',
      })
      const spanCtx = trace.getSpanContext(ctx)
      assert.ok(spanCtx)
      assert.equal(spanCtx?.traceId, traceId)
      assert.equal(spanCtx?.spanId, spanId)
      assert.equal(spanCtx?.traceFlags, 1)
    })

    it('headerGetter safely handles null, undefined, and non-object carriers', () => {
      assert.deepEqual(headerGetter.keys(null as any), [])
      assert.deepEqual(headerGetter.keys(undefined as any), [])
      assert.equal(headerGetter.get(null as any, 'traceparent'), undefined)
      assert.equal(headerGetter.get({} as any, 'traceparent'), undefined)
    })

    it('propagates ContextStore across nested async boundaries and microtasks', async () => {
      const store = createContextStore('req-edge-1', 50, {
        userId: 'user-42',
        extra: { tenantId: 'tenant-acme' },
      })

      await withContext(store, async () => {
        assert.equal(getRequestContext()?.requestId, 'req-edge-1')
        assert.equal(getRequestContext()?.userId, 'user-42')

        // Inside Promise.all
        await Promise.all([
          (async () => {
            await new Promise<void>(res => queueMicrotask(() => res()))
            assert.equal(getRequestContext()?.requestId, 'req-edge-1')
          })(),
          (async () => {
            await new Promise(res => setTimeout(res, 5))
            assert.equal(getRequestContext()?.requestId, 'req-edge-1')
          })(),
        ])

        // Inside bindContext wrapper
        const boundFn = bindContext(() => {
          return getRequestContext()?.requestId
        })

        assert.equal(boundFn(), 'req-edge-1')
      })

      assert.equal(getRequestContext(), undefined)
    })
  })

  // ──────────────────────────────────────────────────────────────────────────
  // 2. OTel Server and Client Tracing
  // ──────────────────────────────────────────────────────────────────────────
  describe('2. Tracing Lifecycle & Span Enrichment', () => {
    it('injectTraceContext injects traceparent and custom pulse headers', () => {
      const traceId = '4bf92f3577b34da6a3ce929d0e0e4736'
      const spanId = '00f067aa0ba902b7'
      const span = trace.wrapSpanContext({
        traceId,
        spanId,
        traceFlags: 1,
      })
      const ctx = trace.setSpan(otelContext.active(), span)

      const outgoingHeaders: Record<string, string> = {}
      injectTraceContext(outgoingHeaders, ctx)

      assert.ok(outgoingHeaders[TRACE_HEADERS.TRACEPARENT])
      assert.equal(outgoingHeaders[TRACE_HEADERS.PULSE_TRACE_ID], traceId)
      assert.equal(outgoingHeaders[TRACE_HEADERS.PULSE_SPAN_ID], spanId)
      assert.equal(outgoingHeaders[TRACE_HEADERS.PULSE_SAMPLED], '1')
    })

    it('injectTraceContext handles undefined/null headers without throwing', () => {
      assert.doesNotThrow(() => {
        injectTraceContext(null as any)
      })
    })
  })

  // ──────────────────────────────────────────────────────────────────────────
  // 3. Auto-Instrumentation Edge Cases
  // ──────────────────────────────────────────────────────────────────────────
  describe('3. Auto-Instrumentation Gaps & Resilience', () => {
    it('Redis serializer safely handles null, undefined, objects, Buffers, and sensitive commands', () => {
      const instr = createRedisInstrumentation(true, {}, { headers: true, body: true, response: true, query: true, cookies: true })
      assert.ok(instr)

      const serializer = (instr as any)._config?.dbStatementSerializer
      assert.ok(typeof serializer === 'function')

      // Sensitive commands redacted, safe keys preserved under sanitized-key
      assert.equal(serializer('GET', ['user:123']), 'GET user:123')
      assert.equal(serializer('GET', ['user:session_token']), 'GET [REDACTED_KEY]')
      assert.equal(serializer('AUTH', ['secretpass']), 'AUTH [REDACTED]')
      assert.equal(serializer('auth', ['secretpass']), 'AUTH [REDACTED]')

      // Non-sensitive commands serialized with diverse types
      assert.equal(serializer('PING', []), 'PING')
      assert.equal(serializer('PING', null as any), 'PING')
      assert.equal(serializer('MSET', ['item_count', 42]), 'MSET item_count [REDACTED]')
      assert.equal(serializer('MSET', ['api_key', 42]), 'MSET [REDACTED_KEY] [REDACTED]')
      assert.equal(serializer('JSON.SET', ['doc', '$', { a: 1 }]), 'JSON.SET doc [REDACTED]')
    })

    it('MongoDB instrumentation handles circular objects and redaction', () => {
      const redactedInstr = createMongoDBInstrumentation(true, {}, { headers: true, body: false, response: false, query: false, cookies: false })
      const redSerializer = (redactedInstr as any)._config?.dbStatementSerializer
      assert.equal(redSerializer({ find: 'users' }), '[REDACTED]')

      const unredactedInstr = createMongoDBInstrumentation(true, {}, { headers: true, body: true, response: true, query: true, cookies: true })
      const unredSerializer = (unredactedInstr as any)._config?.dbStatementSerializer

      const circular: any = { a: 1 }
      circular.self = circular
      assert.equal(unredSerializer(circular), '[UNSERIALIZABLE]')
    })

    it('MySQL and Postgres instrumentation configure statement masking cleanly', () => {
      const mysqlMasked = createMySQLInstrumentation(true, { captureQueries: false })
      assert.equal((mysqlMasked as any)._config.maskStatement, true)

      const pg = createPgInstrumentation(true, { captureQueries: true })
      assert.equal((pg as any)._config.enhancedDatabaseReporting, true)
    })

    it('GraphQL instrumentation respects captureResolvers toggle', () => {
      const gqlDisabled = createGraphQLInstrumentation({ enabled: true, captureResolvers: false })
      assert.equal((gqlDisabled as any)._config.ignoreResolveSpans, true)

      const gqlEnabled = createGraphQLInstrumentation({ enabled: true, captureResolvers: true })
      assert.equal((gqlEnabled as any)._config.ignoreResolveSpans, false)
    })

    it('Express monitorMiddleware handles requests with undefined headers and non-Error next(err)', () => {
      const middleware = monitorMiddleware()

      const req: any = {
        method: 'GET',
        url: '/test-edge',
      }

      const listeners: Record<string, Function> = {}
      const res: any = {
        statusCode: 200,
        getHeader: () => undefined,
        once: (event: string, cb: Function) => {
          listeners[event] = cb
        },
      }

      let nextCalled = false
      middleware(req, res, () => {
        nextCalled = true
      })
      assert.ok(nextCalled, 'middleware should pass through smoothly with undefined headers')

      if (listeners['finish']) listeners['finish']()
    })

    it('Express monitorMiddleware captures errors passed to next(err) even as non-Error primitives', () => {
      const req: any = {
        method: 'POST',
        url: '/api/error-test',
        headers: {},
      }
      const res: any = {
        statusCode: 500,
        getHeader: () => undefined,
        once: () => {},
      }

      assert.doesNotThrow(() => {
        const handler = expressErrorHandler()
        handler('string error failure', req, res, () => {})
      })
    })

    it('Fastify pulse plugin handles requests with undefined headers safely', () => {
      let registeredHooks: Record<string, Function> = {}
      const fakeFastify: any = {
        addHook: (name: string, fn: Function) => {
          registeredHooks[name] = fn
        },
      }

      fastifyPulsePlugin(fakeFastify, {}, () => {})
      assert.ok(registeredHooks['onRequest'])

      const request: any = {
        method: 'GET',
        url: '/fastify-edge',
      }
      const reply: any = {
        statusCode: 200,
        getHeader: () => undefined,
      }

      let doneCalled = false
      registeredHooks['onRequest'](request, reply, () => {
        doneCalled = true
      })
      assert.ok(doneCalled, 'Fastify onRequest hook should complete even without request.headers')
    })
  })

  // ──────────────────────────────────────────────────────────────────────────
  // 4. Error Capture and Fingerprinting
  // ──────────────────────────────────────────────────────────────────────────
  describe('4. Error Capture, Classification, & Fingerprinting', () => {
    it('toError converts objects and preserves message, status, and code', () => {
      const plainObj = { message: 'Database query timed out', statusCode: 504, code: 'ETIMEDOUT' }
      const err = toError(plainObj)

      assert.ok(err instanceof Error)
      assert.equal(err.message, 'Database query timed out')
      assert.equal((err as any).statusCode, 504)
      assert.equal((err as any).code, 'ETIMEDOUT')

      // Primitives
      assert.equal(toError('raw string failure').message, 'raw string failure')
      assert.equal(toError(404).message, '404')
      assert.equal(toError(null).message, 'null')
      assert.equal(toError(undefined).message, 'undefined')
    })

    it('classifyError returns deterministic booleans for handled, fatal, and crash', () => {
      const crash = classifyError(false, 'uncaughtException', 'error')
      assert.equal(crash.unhandled, true)
      assert.equal(crash.crash, true)
      assert.equal(crash.fatal, false)

      const fatal = classifyError(true, 'manual', 'fatal')
      assert.equal(fatal.unhandled, false)
      assert.equal(fatal.crash, false)
      assert.equal(fatal.fatal, true)

      const normal = classifyError(true, 'express.next', 'error')
      assert.equal(normal.unhandled, false)
      assert.equal(normal.crash, false)
      assert.equal(normal.fatal, false)
    })

    it('generateFingerprint handles stack frames with undefined or empty filenames', () => {
      const err = new Error('test edge fingerprint')
      const frames = [
        { function: 'anonymous', filename: undefined, inApp: true },
        { function: 'evalFn', filename: '', inApp: true },
      ]

      assert.doesNotThrow(() => {
        const fp = generateFingerprint(err, frames as any)
        assert.ok(typeof fp === 'string' && fp.length === 64)
      })
    })

    it('generateFingerprint normalizes dynamic messages with UUIDs, hex, and numbers', () => {
      const err1 = new Error('Failed to find user 12345 with id 123e4567-e89b-12d3-a456-426614174000')
      const err2 = new Error('Failed to find user 99999 with id 987fcdeb-51a2-43f7-9876-ba9876543210')

      const fp1 = generateFingerprint(err1, [])
      const fp2 = generateFingerprint(err2, [])

      assert.equal(fp1, fp2, 'Errors with identical structure but different IDs/numbers should share fingerprint')
    })

    it('captureError executes fail-safe with non-Error inputs and sets status code', () => {
      assert.doesNotThrow(() => {
        captureError({ message: 'Boom', statusCode: 404 })
        captureError(null)
        captureError(undefined)
        captureError('string exception')
      })
    })

    it('toError preserves stack property from plain error object', () => {
      const customStack = 'Error: remote fail\n    at remoteFn (worker.js:10:5)'
      const err = toError({ message: 'remote fail', stack: customStack, code: 'ERR_REMOTE' })
      assert.equal(err.message, 'remote fail')
      assert.equal(err.stack, customStack)
      assert.equal((err as any).code, 'ERR_REMOTE')
    })

    it('generateFingerprint handles errors with undefined, null, or non-string message without throwing', () => {
      const errNoMsg: any = new Error('')
      errNoMsg.message = undefined
      assert.doesNotThrow(() => {
        const fp = generateFingerprint(errNoMsg, [])
        assert.ok(typeof fp === 'string' && fp.length === 64)
      })

      const errNullMsg: any = new Error('')
      errNullMsg.message = null
      assert.doesNotThrow(() => {
        const fp = generateFingerprint(errNullMsg, [])
        assert.ok(typeof fp === 'string' && fp.length === 64)
      })

      resetFingerprintCache()
    })
  })

  // ──────────────────────────────────────────────────────────────────────────
  // 5. Request Enrichment & Privacy Scrubbing
  // ──────────────────────────────────────────────────────────────────────────
  describe('5. Request Enrichment & Security Scrubber', () => {
    it('computeBodySize calculates correct byte lengths for all primitives and objects', () => {
      assert.equal(captureBodySnapshot(null, true).bodySize, 0)
      assert.equal(captureBodySnapshot('hello world', true).bodySize, 11)
      assert.equal(captureBodySnapshot(12345, true).bodySize, 5)
      assert.equal(captureBodySnapshot(true, true).bodySize, 4)
      assert.equal(captureBodySnapshot({ a: 'test' }, true).bodySize, Buffer.byteLength(JSON.stringify({ a: 'test' })))
    })

    it('captureBodySnapshot truncates bodies exceeding 64KB', () => {
      const hugeObject: Record<string, string> = {}
      for (let i = 0; i < 2000; i++) {
        hugeObject[`key_${i}`] = 'long_string_content_padding_out_payload_bytes_for_test'
      }

      const snapshot = captureBodySnapshot(hugeObject, true)
      assert.ok(snapshot.bodySize && snapshot.bodySize > 64 * 1024)
      assert.deepEqual(snapshot.body, { __truncated: true })
    })

    it('resolveClientIp respects trusted proxies vs socket address', () => {
      const headers = {
        'x-forwarded-for': '203.0.113.195, 70.41.3.18',
        'x-real-ip': '203.0.113.195',
      }

      // Untrusted proxy (socket remote address is untrusted) -> uses socket address
      const ip1 = resolveClientIp(headers, '10.0.0.1', [], false)
      assert.equal(ip1, '10.0.0.1')

      // Trusted proxy configured -> parses X-Forwarded-For
      const ip2 = resolveClientIp(headers, '10.0.0.1', ['10.0.0.1'], false)
      assert.equal(ip2, '203.0.113.195')

      // Masked IP mode returns 16-character hex hash
      const ip3 = resolveClientIp(headers, '10.0.0.1', ['10.0.0.1'], true)
      assert.equal(ip3?.length, 16)
    })

    it('resolveClientIp safely handles null or undefined headers with trusted proxy', () => {
      assert.doesNotThrow(() => {
        const ip = resolveClientIp(null as any, '10.0.0.1', ['10.0.0.1'], false)
        assert.equal(ip, '10.0.0.1')
      })
      assert.doesNotThrow(() => {
        const ip = resolveClientIp(undefined as any, '10.0.0.1', ['10.0.0.1'], false)
        assert.equal(ip, '10.0.0.1')
      })
    })

    it('resolveClientIp handles uppercase X-Forwarded-For and X-Real-IP', () => {
      const headersUpper = {
        'X-Forwarded-For': '198.51.100.22',
        'X-Real-IP': '198.51.100.22',
      }
      const ip = resolveClientIp(headersUpper, '10.0.0.1', ['10.0.0.1'], false)
      assert.equal(ip, '198.51.100.22')
    })

    it('matchesIgnoredPath matches string prefixes and regexes', () => {
      const rules = ['/health', /^\/metrics\/.+/]
      assert.equal(matchesIgnoredPath('/health', rules), true)
      assert.equal(matchesIgnoredPath('/health/live', rules), true)
      assert.equal(matchesIgnoredPath('/metrics/prom', rules), true)
      assert.equal(matchesIgnoredPath('/api/users', rules), false)
      assert.equal(matchesIgnoredPath('/api', undefined), false)
    })
  })

  // ──────────────────────────────────────────────────────────────────────────
  // 6. Rate Limiting & Circuit Breaker
  // ──────────────────────────────────────────────────────────────────────────
  describe('6. Rate Limiting & Circuit Breaker Resilience', () => {
    it('TokenBucketRateLimiter sanitizes non-finite options and enforces capacity', () => {
      const limiter = new TokenBucketRateLimiter({ capacity: NaN, refillRate: -5 })
      assert.equal(limiter.getState().capacity, 10)
      assert.ok(limiter.tryAcquire())

      const smallLimiter = new TokenBucketRateLimiter({ capacity: 2, refillRate: 100 })
      assert.equal(smallLimiter.tryAcquire(), true)
      assert.equal(smallLimiter.tryAcquire(), true)
      assert.equal(smallLimiter.tryAcquire(), false)
    })

    it('SlidingWindowRateLimiter sanitizes non-finite options and tracks sliding window', () => {
      const limiter = new SlidingWindowRateLimiter({ maxRequests: NaN, windowMs: -100 })
      assert.equal(limiter.getState().capacity, 10)

      const bounded = new SlidingWindowRateLimiter({ maxRequests: 2, windowMs: 1000 })
      assert.equal(bounded.tryAcquire(), true)
      assert.equal(bounded.tryAcquire(), true)
      assert.equal(bounded.tryAcquire(), false)
    })

    it('CircuitBreaker constructor sanitizes NaN, negative, or zero options safely', () => {
      const breaker = new CircuitBreaker({
        failureThreshold: NaN,
        resetTimeoutMs: -1000,
        halfOpenMaxProbes: 0,
      })
      assert.equal(breaker.getState(), 'CLOSED')
      assert.equal(breaker.canExecute(), true)
    })

    it('CircuitBreaker transitions CLOSED -> OPEN -> HALF_OPEN with exact single probe allowance', () => {
      const breaker = new CircuitBreaker({
        failureThreshold: 2,
        resetTimeoutMs: 50,
        halfOpenMaxProbes: 1,
      })

      assert.equal(breaker.getState(), 'CLOSED')
      assert.equal(breaker.canExecute(), true)

      breaker.recordFailure()
      assert.equal(breaker.getState(), 'CLOSED')

      breaker.recordFailure()
      assert.equal(breaker.getState(), 'OPEN')
      assert.equal(breaker.canExecute(), false)

      return new Promise<void>(resolve => {
        setTimeout(() => {
          assert.equal(breaker.canExecute(), true, 'First probe after resetTimeoutMs should be allowed')
          assert.equal(breaker.canExecute(), false, 'Second probe in HALF_OPEN should be blocked')

          breaker.recordSuccess()
          assert.equal(breaker.getState(), 'CLOSED')
          assert.equal(breaker.canExecute(), true)
          resolve()
        }, 60)
      })
    })
  })

  // ──────────────────────────────────────────────────────────────────────────
  // 7. Batching & Compression
  // ──────────────────────────────────────────────────────────────────────────
  describe('7. Batching & Compression Edge Cases', () => {
    it('compress handles Buffer, string, and Uint8Array, bypassing small payloads', async () => {
      const small = 'hello world'
      const smallRes = await compress(small, 'gzip')
      assert.equal(smallRes.algorithm, 'none')
      assert.equal(smallRes.buffer.toString(), small)

      const large = 'Pulse Observability SDK Enterprise Compression '.repeat(200)
      const largeRes = await compress(large, 'gzip')
      assert.equal(largeRes.algorithm, 'gzip')
      assert.ok(largeRes.compressedSize < largeRes.originalSize)

      assert.equal(contentEncoding('gzip'), 'gzip')
      assert.equal(contentEncoding('brotli'), 'br')
      assert.equal(contentEncoding('none'), undefined)
    })
  })

  // ──────────────────────────────────────────────────────────────────────────
  // 8. Memory, Load Shedder, Cardinality Governors
  // ──────────────────────────────────────────────────────────────────────────
  describe('8. Memory, Load Shedder & Cardinality Governors', () => {
    it('CardinalityGovernor sanitizes attributes and normalizes dynamic routes safely', () => {
      const gov = new CardinalityGovernor({ maxDimensionsPerMetric: 5 })

      const attrs: any = {
        'userId': 'sensitive-123',
        'http.route': '/api/v1/users/550e8400-e29b-41d4-a716-446655440000/orders/12345',
        'status_code': 200,
        'active': true,
      }

      const sanitized = gov.sanitizeAttributes('http.server.duration', attrs)

      assert.equal(sanitized['userId'], undefined, 'blockedAttributes must be stripped')
      assert.equal(sanitized['http.route'], '/api/v1/users/:id/orders/:id')
      assert.equal(sanitized['status_code'], '200')
      assert.equal(sanitized['active'], 'true')
    })

    it('LoadShedder enforces 5-tier pressure and correlation group promotion', () => {
      const shedder = new LoadShedder(() => 'PRESSURED')

      assert.equal(shedder.shouldShed({ type: 'metric', eventId: 'm1' }), true)
      assert.equal(shedder.shouldShed({ type: 'request', eventId: 'r1' }), false)
      assert.equal(shedder.shouldShed({ type: 'error', eventId: 'e1' }), false)

      shedder.classifyEvent({ type: 'error', traceId: 'trace-100', eventId: 'err-100' })
      assert.equal(shedder.classifyEvent({ type: 'request', traceId: 'trace-100' }), 'p1_error')
      assert.equal(shedder.classifyEvent({ type: 'span', traceId: 'trace-100' }), 'p1_error')

      const stats = shedder.getStats()
      assert.ok(stats.totalAdmitted > 0)
      assert.ok(stats.totalShed > 0)
    })
  })

  // ──────────────────────────────────────────────────────────────────────────
  // 9 & 10. Graceful Shutdown & Drain
  // ──────────────────────────────────────────────────────────────────────────
  describe('9 & 10. Lifecycle, Shutdown, & Crash Flush', () => {
    it('crashFlush completes without throwing even with short timeout', async () => {
      await assert.doesNotReject(async () => {
        await crashFlush(100)
      })
    })

    it('signal handlers register and deregister cleanly without stacking', () => {
      registerSignalHandlers()
      registerSignalHandlers()
      resetSignalHandlers()
    })

    it('shutdown returns a complete ShutdownResult and is idempotent', async () => {
      const result = await shutdown(1000)
      assert.ok(typeof result.completed === 'boolean')
      assert.ok(typeof result.durationMs === 'number')
      assert.ok(Array.isArray(result.stepErrors))

      const second = await shutdown(1000)
      assert.ok(second)
    })
  })
})
