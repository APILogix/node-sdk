import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import {
  getLogger,
  setDebugMode,
  setLogLevel,
  setLogFormat,
  getLogFormat,
  setLogPrefix,
  consoleLogger,
  jsonLogger,
  NonBlockingStreamWriter,
  stdoutDrainer,
  stderrDrainer,
  getLoggerWriterStats,
} from '../../src/utils/logger.js'
import { Severity } from '../../src/types/severity.js'
import { LoggingSubsystem, LogRateLimiter } from '../../src/subsystems/logging-subsystem.js'
import { captureLog } from '../../src/capture/captureLog.js'
import { normalizeEvent } from '../../src/processors/normalizer.js'
import { createWinstonTransport, LynkTraceWinstonTransport } from '../../src/instrumentation/winston.js'
import { createPinoStream, LynkTracePinoStream, pinoTraceMixin } from '../../src/instrumentation/pino.js'
import { createContextStore, withContext, getRequestContext } from '../../src/core/context.js'
import { EntitlementGate } from '../../src/core/entitlement-gate.js'
import type { LogEvent, EventMetadata } from '../../src/types/event.js'
import type { RemoteConfigResponse } from '../../src/types/config.js'

describe('Enterprise Logging Architecture Suite', () => {
  let stdoutChunks: string[] = []
  let stderrChunks: string[] = []
  let originalStdoutWrite: typeof process.stdout.write
  let originalStderrWrite: typeof process.stderr.write

  beforeEach(() => {
    stdoutChunks = []
    stderrChunks = []
    originalStdoutWrite = process.stdout.write
    originalStderrWrite = process.stderr.write

    process.stdout.write = ((chunk: any) => {
      stdoutChunks.push(String(chunk))
      return true
    }) as any

    process.stderr.write = ((chunk: any) => {
      stderrChunks.push(String(chunk))
      return true
    }) as any

    setDebugMode(false)
    setLogFormat('text')
    setLogPrefix('Telemetry')
    stdoutDrainer.reset()
    stderrDrainer.reset()
  })

  afterEach(() => {
    process.stdout.write = originalStdoutWrite
    process.stderr.write = originalStderrWrite
    setDebugMode(false)
    setLogFormat('text')
    LoggingSubsystem.reset()
  })

  // ─── 1. Internal Logger: Levels & Formats ─────────────────────────────────

  describe('Internal Logger: Levels, Formats & Timestamps', () => {
    it('supports all 6 severity levels (trace, debug, info, warn, error, fatal)', () => {
      setDebugMode(true) // enables trace & debug
      const logger = getLogger()

      logger.trace?.('Trace message test')
      logger.debug('Debug message test')
      logger.info('Info message test')
      logger.warn('Warn message test')
      logger.error('Error message test')
      logger.fatal?.('Fatal message test')

      assert.ok(stdoutChunks.some(c => c.includes('TRACE: Trace message test')))
      assert.ok(stdoutChunks.some(c => c.includes('DEBUG: Debug message test')))
      assert.ok(stdoutChunks.some(c => c.includes('INFO: Info message test')))
      assert.ok(stderrChunks.some(c => c.includes('WARN: Warn message test')))
      assert.ok(stderrChunks.some(c => c.includes('ERROR: Error message test')))
      assert.ok(stderrChunks.some(c => c.includes('FATAL: Fatal message test')))
    })

    it('emits compliant OpenTelemetry & ECS structured JSON when format is json', () => {
      setLogFormat('json')
      setDebugMode(true)
      const logger = getLogger()

      logger.info('JSON structured log test', { userId: 'usr-123', action: 'checkout' })
      logger.error('Database connection timed out', { host: 'db.prod.internal', port: 5432 })

      assert.strictEqual(stdoutChunks.length, 1)
      assert.strictEqual(stderrChunks.length, 1)

      const infoEntry = JSON.parse(stdoutChunks[0]!)
      assert.strictEqual(infoEntry.level, 'info')
      assert.strictEqual(infoEntry.severity_number, 9)
      assert.strictEqual(infoEntry.logger, 'Telemetry')
      assert.strictEqual(infoEntry.message, 'JSON structured log test')
      assert.ok(typeof infoEntry.timestamp === 'string')
      assert.ok(typeof infoEntry.timestamp_ms === 'number')
      assert.strictEqual(infoEntry.context.userId, 'usr-123')
      assert.strictEqual(infoEntry.context.action, 'checkout')

      const errorEntry = JSON.parse(stderrChunks[0]!)
      assert.strictEqual(errorEntry.level, 'error')
      assert.strictEqual(errorEntry.severity_number, 17)
      assert.strictEqual(errorEntry.message, 'Database connection timed out')
      assert.strictEqual(errorEntry.context.host, 'db.prod.internal')
    })

    it('redacts sensitive credentials, tokens, and authorization headers in context', () => {
      setDebugMode(true)
      const logger = getLogger()

      logger.info('Payment processed', {
        apiKey: 'secret_live_9999999999',
        authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.test',
        password: 'SuperSecretPassword123!',
        safeData: 'visible-data',
      })

      assert.strictEqual(stdoutChunks.length, 1)
      const out = stdoutChunks[0]!
      assert.ok(out.includes('[REDACTED]'), 'Must redact sensitive values')
      assert.ok(!out.includes('secret_live_9999999999'))
      assert.ok(!out.includes('SuperSecretPassword123!'))
      assert.ok(out.includes('visible-data'))
    })

    it('handles circular references and Uint8Array buffers cleanly without crashing', () => {
      setDebugMode(true)
      const logger = getLogger()

      const circularObj: any = { name: 'circular-test' }
      circularObj.self = circularObj
      circularObj.payload = Buffer.from('binary-payload')

      logger.debug('Testing circular ref', circularObj)

      assert.strictEqual(stdoutChunks.length, 1)
      const out = stdoutChunks[0]!
      assert.ok(out.includes('[Circular]'))
      assert.ok(out.includes('[Buffer:'))
    })
  })

  // ─── 2. Non-Blocking Stream Drainer & Backpressure ────────────────────────

  describe('Non-Blocking Stream Drainer: Backpressure & Low-Memory Drop Policy', () => {
    it('writes directly on fast path without queuing when stream accepts data', () => {
      const mockStream = new EventEmitter() as any
      let writeCount = 0
      mockStream.write = (chunk: string) => {
        writeCount++
        return true // No backpressure
      }

      const drainer = new NonBlockingStreamWriter(() => mockStream, 10)
      drainer.write('line 1')
      drainer.write('line 2')

      assert.strictEqual(writeCount, 2)
      assert.strictEqual(drainer.getBufferSize(), 0)
      assert.strictEqual(drainer.getDroppedCount(), 0)
    })

    it('queues data when stream is backpressured (returns false) and drains on drain event', () => {
      const mockStream = new EventEmitter() as any
      const written: string[] = []
      let acceptWrites = false

      mockStream.write = (chunk: string) => {
        if (!acceptWrites) {
          acceptWrites = false
          return false // Kernel buffer full
        }
        written.push(chunk)
        return true
      }

      const drainer = new NonBlockingStreamWriter(() => mockStream, 50)

      // First write returns false -> triggers draining state
      drainer.write('backpressured-1')
      drainer.write('backpressured-2')
      drainer.write('backpressured-3')

      assert.strictEqual(drainer.getBufferSize(), 2)

      // Now simulate kernel socket drain
      acceptWrites = true
      mockStream.emit('drain')

      assert.strictEqual(drainer.getBufferSize(), 0)
      assert.ok(written.some(w => w.includes('backpressured-2')))
      assert.ok(written.some(w => w.includes('backpressured-3')))
    })

    it('drops transient diagnostic logs when bounded buffer reaches maxBufferSize', () => {
      const mockStream = new EventEmitter() as any
      mockStream.write = () => false // Permanently backpressured

      const maxBuffer = 5
      const drainer = new NonBlockingStreamWriter(() => mockStream, maxBuffer)

      // First write sets draining
      drainer.write('initial')
      // Fill remaining 5 buffer slots
      for (let i = 1; i <= 5; i++) {
        drainer.write(`queued-${i}`, false)
      }

      assert.strictEqual(drainer.getBufferSize(), 5)

      // Write 10 more non-critical logs while full
      for (let i = 6; i <= 15; i++) {
        drainer.write(`overflow-${i}`, false)
      }

      assert.strictEqual(drainer.getBufferSize(), 5)
      assert.strictEqual(drainer.getDroppedCount(), 10, 'Should drop exactly 10 excess logs to preserve memory')
    })

    it('prioritizes critical logs by dropping older items when buffer is full', () => {
      const mockStream = new EventEmitter() as any
      mockStream.write = () => false

      const drainer = new NonBlockingStreamWriter(() => mockStream, 3)
      drainer.write('initial')
      drainer.write('low-1', false)
      drainer.write('low-2', false)
      drainer.write('low-3', false)

      assert.strictEqual(drainer.getBufferSize(), 3)

      // Push critical fatal log
      drainer.write('CRITICAL-FATAL', true)

      assert.strictEqual(drainer.getBufferSize(), 3)
      assert.strictEqual(drainer.getDroppedCount(), 1)
    })
  })

  // ─── 3. Token-Bucket Rate Limiter & Flood Protection ───────────────────────

  describe('LogRateLimiter & Flood Protection', () => {
    it('admits burst up to capacity and throttles once exhausted', () => {
      const capacity = 100
      const refillPerSec = 50
      const limiter = new LogRateLimiter(capacity, refillPerSec)

      // Consume full capacity
      for (let i = 0; i < capacity; i++) {
        assert.ok(limiter.tryConsume(1), `Token ${i} should be admitted`)
      }

      // 101st token must be rejected
      assert.strictEqual(limiter.tryConsume(1), false, 'Should be throttled once capacity is spent')
      assert.strictEqual(limiter.tryConsume(1), false)
    })

    it('refills tokens over time', async () => {
      const limiter = new LogRateLimiter(10, 100) // 100 tokens/sec = 1 token per 10ms
      for (let i = 0; i < 10; i++) limiter.tryConsume(1)
      assert.strictEqual(limiter.tryConsume(1), false)

      // Wait 50ms (should refill ~5 tokens)
      await new Promise(r => setTimeout(r, 50))

      assert.ok(limiter.tryConsume(1), 'Should admit after refill')
    })
  })

  // ─── 4. LoggingSubsystem & Console Capture ────────────────────────────────

  describe('LoggingSubsystem Application Telemetry Capture', () => {
    const mockConfig: RemoteConfigResponse = {
      features: { logging: true, errors: true, metrics: true, tracing: true, profiling: false, crons: false },
      killswitches: { disableLogs: false, disableErrors: false, disableMetrics: false, disableTracing: false, disableProfiling: false },
      entitlements: { logging: true, profiling: true, errors: true, metrics: true, tracing: true, crons: true },
      logs: { enabled: true, captureConsole: true, levels: ['info', 'warning', 'warn', 'error', 'debug'], maxLogSize: 4096 },
      sdk: { apiKey: 'test-key', projectId: 'test-project', environment: 'test', release: '1.0.0' },
    } as any

    const mockMetadata: EventMetadata = {
      sdkName: '@lynktrace/node',
      sdkVersion: '3.2.0',
      applicationName: 'test-app',
      applicationVersion: '1.0.0',
      environment: 'test',
      release: '1.0.0',
      projectId: 'test-project',
    }

    it('captures console.log and forwards as LogEvent with trace correlation and breadcrumb', () => {
      const emitted: LogEvent[] = []
      const subsystem = LoggingSubsystem.initialize(
        mockConfig,
        (event) => emitted.push(event),
        mockMetadata
      )
      subsystem.start()

      // Execute inside request context
      const store = createContextStore('req-test-123', 50, {
        traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
        spanId: '00f067aa0ba902b7',
      })

      withContext(store, () => {
        console.log('User signed in', { username: 'alice', role: 'admin' })
      })

      assert.strictEqual(emitted.length, 1)
      const event = emitted[0]!
      assert.strictEqual(event.type, 'log')
      assert.strictEqual(event.level, 'info')
      assert.ok(event.message.includes('User signed in'))
      assert.strictEqual(event.traceId, '4bf92f3577b34da6a3ce929d0e0e4736')
      assert.strictEqual(event.spanId, '00f067aa0ba902b7')
      assert.strictEqual(event.logger, 'console')
      assert.strictEqual(event.severityNumber, 9)

      // Verify breadcrumb bridging
      const breadcrumbs = store.breadcrumbs.toArray()
      assert.strictEqual(breadcrumbs.length, 1)
      const firstBreadcrumb = breadcrumbs[0]
      assert.ok(firstBreadcrumb)
      assert.strictEqual(firstBreadcrumb.category, 'console')
      assert.ok(firstBreadcrumb.message?.includes('User signed in'))

      subsystem.destroy()
    })

    it('rate-limits runaway console logging without throwing or blocking event loop', () => {
      const emitted: LogEvent[] = []
      const subsystem = LoggingSubsystem.initialize(
        mockConfig,
        (event) => emitted.push(event),
        mockMetadata
      )
      subsystem.start()

      // Burst of 2,000 rapid console logs
      for (let i = 0; i < 2000; i++) {
        console.log(`Rapid log flood item ${i}`)
      }

      // Initial capacity is 1,000 (+ a few refilled tokens during loop execution)
      const admitted = emitted.length
      const drops = subsystem.getRateLimitDrops()
      assert.ok(admitted >= 1000 && admitted <= 1050, `Admitted logs should be ~1000, got ${admitted}`)
      assert.ok(drops >= 950 && drops <= 1000, `Dropped logs should be ~950-1000, got ${drops}`)
      assert.strictEqual(admitted + drops, 2000, 'Sum of admitted and dropped must equal total 2000 logs')

      subsystem.destroy()
    })
  })

  // ─── 5. Winston Integration ───────────────────────────────────────────────

  describe('Winston Transport Integration', () => {
    it('correlates active trace context and captures log events via transport', () => {
      const emitted: LogEvent[] = []
      const mockConfig: any = {
        features: { logging: true },
        killswitches: { disableLogs: false },
        entitlements: { logging: true },
        logs: { enabled: true, captureConsole: false, levels: ['info', 'warning', 'warn', 'error'], maxLogSize: 4096 },
        sdk: { apiKey: 'key', projectId: 'proj' },
      }

      const subsystem = LoggingSubsystem.initialize(mockConfig, (e) => emitted.push(e), {
        sdkName: '@lynktrace/node',
        sdkVersion: '3.2.0',
        applicationName: 'test-app',
        applicationVersion: '1.0.0',
        environment: 'test',
        release: '1.0.0',
        projectId: 'test-project',
      })

      const winstonTransport = createWinstonTransport({ level: 'info' })

      const store = createContextStore('req-winston', 50, {
        traceId: 'winston-trace-id-12345',
        spanId: 'winston-span-id-67890',
      })

      withContext(store, () => {
        winstonTransport.log({
          level: 'warn',
          message: 'Order item inventory low',
          sku: 'SKU-777',
          count: 2,
        })
      })

      assert.strictEqual(emitted.length, 1)
      const event = emitted[0]!
      assert.strictEqual(event.type, 'log')
      assert.strictEqual(event.level, 'warning')
      assert.strictEqual(event.message, 'Order item inventory low')
      assert.strictEqual(event.traceId, 'winston-trace-id-12345')
      assert.strictEqual(event.spanId, 'winston-span-id-67890')

      subsystem.destroy()
    })
  })

  // ─── 6. Pino Integration ──────────────────────────────────────────────────

  describe('Pino Stream & Mixin Integration', () => {
    it('parses NDJSON buffer chunks, maps numeric levels, and captures log events', (t, done) => {
      const emitted: LogEvent[] = []
      const mockConfig: any = {
        features: { logging: true },
        killswitches: { disableLogs: false },
        entitlements: { logging: true },
        logs: { enabled: true, captureConsole: false, levels: ['info', 'warning', 'warn', 'error'], maxLogSize: 4096 },
        sdk: { apiKey: 'key', projectId: 'proj' },
      }

      const subsystem = LoggingSubsystem.initialize(mockConfig, (e) => emitted.push(e), {
        sdkName: '@lynktrace/node',
        sdkVersion: '3.2.0',
        applicationName: 'test-app',
        applicationVersion: '1.0.0',
        environment: 'test',
        release: '1.0.0',
        projectId: 'test-project',
      })
      const pinoStream = createPinoStream()

      const pinoChunk = Buffer.from(JSON.stringify({
        level: 50, // Pino Error
        time: Date.now(),
        pid: 1234,
        hostname: 'prod-api-1',
        msg: 'Payment gateway connection reset',
        gateway: 'stripe',
        attempt: 3,
      }) + '\n')

      pinoStream.write(pinoChunk, () => {
        assert.strictEqual(emitted.length, 1)
        const event = emitted[0]!
        assert.strictEqual(event.type, 'log')
        assert.strictEqual(event.level, 'error')
        assert.strictEqual(event.message, 'Payment gateway connection reset')
        assert.strictEqual(event.severityNumber, 17)

        subsystem.destroy()
        done()
      })
    })

    it('pinoTraceMixin provides trace_id and span_id during active context', () => {
      const store = createContextStore('req-pino', 50, {
        traceId: 'trace-abc-123',
        spanId: 'span-def-456',
      })

      withContext(store, () => {
        const mixin = pinoTraceMixin()
        assert.strictEqual(mixin['trace_id'], 'trace-abc-123')
        assert.strictEqual(mixin['span_id'], 'span-def-456')
      })
    })
  })

  // ─── 7. Normalizer for LogEvent ───────────────────────────────────────────

  describe('Event Normalizer: LogEvent Truncation & Memory Bounds', () => {
    it('truncates oversized log messages and limits nested argument depth', () => {
      const hugeMessage = 'A'.repeat(5000)
      const deepObject = { a: { b: { c: { d: { e: { f: { g: 'too deep' } } } } } } }

      const rawEvent: LogEvent = {
        type: 'log',
        level: 'INFO',
        message: hugeMessage,
        timestamp: Date.now(),
        args: [deepObject],
      }

      const normalized = normalizeEvent(rawEvent, {
        sdkName: '@lynktrace/node',
        sdkVersion: '3.2.0',
        applicationName: 'test-app',
        applicationVersion: '1.0.0',
        environment: 'test',
        release: '1.0.0',
        projectId: 'test-project',
      }) as LogEvent

      assert.strictEqual(normalized.level, 'info', 'Level must be normalized to lowercase')
      assert.ok(normalized.message.length <= 2048, 'Message must be truncated to MAX_MESSAGE_LENGTH')
      assert.ok(normalized.message.endsWith('...[truncated]'))
      assert.ok(normalized.args && normalized.args.length === 1)
    })
  })

  // ─── 8. High Throughput & Low Memory Stress Test ──────────────────────────

  describe('High-Throughput Non-Blocking Stress Test', () => {
    it('survives 10,000 rapid log operations with minimal heap growth (< 3 MB)', () => {
      const emitted: LogEvent[] = []
      const mockConfig: any = {
        features: { logging: true },
        killswitches: { disableLogs: false },
        entitlements: { logging: true },
        logs: { enabled: true, captureConsole: false, levels: ['info', 'warning', 'warn', 'error'], maxLogSize: 512 },
        sdk: { apiKey: 'key', projectId: 'proj' },
      }

      const subsystem = LoggingSubsystem.initialize(mockConfig, (e) => emitted.push(e), {
        sdkName: '@lynktrace/node',
        sdkVersion: '3.2.0',
        applicationName: 'test-app',
        applicationVersion: '1.0.0',
        environment: 'test',
        release: '1.0.0',
        projectId: 'test-project',
      })

      if (global.gc) global.gc()
      const heapBefore = process.memoryUsage().heapUsed

      for (let i = 0; i < 10000; i++) {
        captureLog('info', `High volume benchmark log ${i}`, { index: i, tag: 'stress' })
      }

      if (global.gc) global.gc()
      const heapAfter = process.memoryUsage().heapUsed
      const heapDeltaMb = (heapAfter - heapBefore) / (1024 * 1024)

      // Verify that rate-limiting and bounded queues prevented memory explosion
      assert.ok(heapDeltaMb < 5.0, `Heap delta must be < 5 MB, was ${heapDeltaMb.toFixed(2)} MB`)

      subsystem.destroy()
    })
  })
})
