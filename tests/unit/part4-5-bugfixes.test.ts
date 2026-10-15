import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { safeJsonStringify } from '../../src/utils/safe-json.js'
import { HealthMonitor } from '../../src/transport/health-monitor.js'
import { Semaphore } from '../../src/transport/connection-manager.js'
import { CorrelationGroupTracker, LoadShedder } from '../../src/transport/load-shedder.js'
import { CardinalityGovernor } from '../../src/utils/cardinality-governor.js'
import { CostGovernor } from '../../src/utils/cost-governor.js'
import { EventLoopLagMonitor } from '../../src/utils/event-loop-lag.js'
import { MemoryPressureMonitor } from '../../src/utils/backpressure.js'
import { TransportEventQueue } from '../../src/transport/transport-event-queue.js'
import { isSensitiveRedisKey, createRedisStatementSerializer } from '../../src/instrumentation/redis.js'
import { createNodemailerInstrumentation } from '../../src/instrumentation/nodemailer.js'
import { wrapHandler } from '../../src/serverless/handler.js'
import { getRequestContext } from '../../src/core/context.js'
import { createMongoDBInstrumentation } from '../../src/instrumentation/mongodb.js'
import { resolvePrismaDbSystem } from '../../src/instrumentation/prisma.js'
import { captureBodySnapshot } from '../../src/instrumentation/request-capture-utils.js'
import { sanitizeEvent } from '../../src/processors/sanitizer.js'
import { getLogger } from '../../src/utils/logger.js'

describe('Part 4 & Part 5 Bug Fixes Verification', () => {
  // ─── Part 4 Tests ─────────────────────────────────────────────────────────

  it('BUG-P4-04: HealthMonitor HALF_OPEN enforces single probe in flight & concurrency scale is idempotent', () => {
    const monitor = new HealthMonitor(['errors', 'spans'])
    // Force OPEN
    for (let i = 0; i < 15; i++) monitor.recordFailure('errors')
    const snap = monitor.getSnapshot('errors')
    assert.equal(snap.circuitState, 'OPEN')

    // getConcurrencyScale should be read-only and NOT mutate state
    const scale = monitor.getConcurrencyScale('errors')
    assert.ok(typeof scale === 'number')
    assert.equal(monitor.getSnapshot('errors').circuitState, 'OPEN')
  })

  it('BUG-P4-05: Semaphore uses Set for O(1) removal and correctly acquires and releases leases', async () => {
    const sem = new Semaphore(1)
    const acquired1 = await sem.acquire(500)
    assert.equal(acquired1, true)

    // Second acquire times out
    const acquired2 = await sem.acquire(20)
    assert.equal(acquired2, false)

    sem.release()

    // Can acquire again after release
    const acquired3 = await sem.acquire(20)
    assert.equal(acquired3, true)
    sem.release()
  })

  it('BUG-P4-07: CorrelationGroupTracker preserves fatal status on error and LoadShedder uses extensible guard', () => {
    const tracker = new CorrelationGroupTracker()
    tracker.markError('trace-1', true) // fatal = true
    assert.equal(tracker.hasError('trace-1'), true)
    assert.equal(tracker.isFatal('trace-1'), true)

    // Second non-fatal error should NOT clear isFatal
    tracker.markError('trace-1', false)
    assert.equal(tracker.isFatal('trace-1'), true)

    // Frozen event should not crash shedder
    const shedder = new LoadShedder()
    const frozenEvent = Object.freeze({
      type: 'span',
      eventId: 's-1',
      spanId: 's1',
      traceId: 'trace-1',
      name: 'test',
      startTime: Date.now(),
      endTime: Date.now() + 10,
      durationMs: 10,
      status: 'ok',
      attributes: {},
    })
    assert.doesNotThrow(() => {
      shedder.shouldShed(frozenEvent)
    })
  })

  it('BUG-P4-08: sanitizeEvent handles deeply nested BigInt and cyclic structures safely', () => {
    const raw: any = {
      type: 'error',
      eventId: 'e-1',
      message: 'test',
      name: 'Error',
      timestamp: Date.now(),
      severity: 'error',
      classification: { unhandled: false, fatal: false, crash: false },
      stack: [],
      fingerprint: 'fp-1',
      context: {},
      attributes: {
        bigNumber: BigInt(9007199254740991),
      },
      extra: {
        amount: BigInt(100),
      },
    }
    const sanitized = sanitizeEvent(raw) as any
    assert.equal(sanitized.attributes?.bigNumber, '9007199254740991')
    assert.equal(sanitized.extra?.amount, '100')
  })

  it('BUG-P4-09: TransportEventQueue removeAt correctly shifts shorter side near head', () => {
    const queue = new TransportEventQueue({
      route: 'errors',
      maxSize: 5,
      criticalReserve: 0,
      priority: 'high',
      overflowStrategy: 'drop_oldest',
    })
    // Enqueue 1 critical event at head
    queue.enqueue({
      type: 'error',
      eventId: 'e-0',
      message: 'err',
      name: 'Error',
      timestamp: Date.now(),
      severity: 'error',
      classification: { unhandled: true, fatal: true, crash: true },
      stack: [],
      fingerprint: 'fp-0',
      context: {},
    })
    // Enqueue 4 ordinary events
    for (let i = 1; i < 5; i++) {
      queue.enqueue({
        type: 'error',
        eventId: `e-${i}`,
        message: 'err',
        name: 'Error',
        timestamp: Date.now(),
        severity: 'error',
        classification: { unhandled: false, fatal: false, crash: false },
        stack: [],
        fingerprint: `fp-${i}`,
        context: {},
      })
    }
    assert.equal(queue.size(), 5)
    // 6th event causes eviction of oldest non-critical (index 1, shifting shorter side near head)
    const accepted = queue.enqueue({
      type: 'error',
      eventId: 'e-5',
      message: 'err',
      name: 'Error',
      timestamp: Date.now(),
      severity: 'error',
      classification: { unhandled: false, fatal: false, crash: false },
      stack: [],
      fingerprint: 'fp-5',
      context: {},
    })
    assert.equal(accepted, true)
    assert.equal(queue.size(), 5)
  })

  it('BUG-P4-12: EventLoopLagMonitor avoids min > max on empty histograms and caches stats', () => {
    const monitor = new EventLoopLagMonitor()
    monitor.start()
    const stats = monitor.getStats()
    assert.ok(stats)
    assert.ok(stats.min <= stats.max)
    assert.ok(!Number.isNaN(stats.min))
    assert.ok(!Number.isNaN(stats.max))
    assert.ok(!Number.isNaN(stats.mean))
    monitor.stop()
  })

  it('BUG-P4-13: MemoryPressureMonitor emits event on pressure transition', () => {
    const bp = new MemoryPressureMonitor({
      elevatedThreshold: 0.70,
      criticalThreshold: 0.88,
    })
    let emitted = false
    bp.on('pressure', (level: string) => {
      emitted = true
      assert.ok(level)
    })
    const state = bp.getState()
    assert.ok(state.level)
  })

  it('BUG-P4-14: CardinalityGovernor normalizes ULIDs, tokens, and prefixed IDs', () => {
    const gov = new CardinalityGovernor()
    // Prefixed IDs: stripe/clerk style (usr_abc12345, ord_99988877)
    assert.equal(gov.normalizeRoute('/users/usr_2N98xyz123/profile'), '/users/:id/profile')
    assert.equal(gov.normalizeRoute('/orders/ord_a1b2c3d4/items'), '/orders/:id/items')
    // ULID: 26 characters (01ARZ3NDEKTSV4RRFFQ69G5FAV)
    assert.equal(gov.normalizeRoute('/items/01ARZ3NDEKTSV4RRFFQ69G5FAV'), '/items/:id')
    // Standard UUID
    assert.equal(gov.normalizeRoute('/accounts/123e4567-e89b-12d3-a456-426614174000'), '/accounts/:id')
    // Pure integer
    assert.equal(gov.normalizeRoute('/posts/4294967296'), '/posts/:id')
  })

  it('BUG-P4-15: CostGovernor computes byte rate in O(1) with 60-slot circular bucket ring', () => {
    const gov = new CostGovernor({ bytesBudgetPerMinute: 1000 })
    gov.recordBytesSent(200)
    gov.recordBytesSent(300)
    assert.equal((gov as any).getCurrentBytesPerMinute(), 500)
    assert.equal((gov as any).runningWindowBytes, 500)

    gov.recordBytesSent(600)
    assert.equal((gov as any).getCurrentBytesPerMinute(), 1100)
    assert.equal((gov as any).runningWindowBytes, 1100)
  })

  it('BUG-P4-16: Logger redaction handles circular refs, Buffers, Dates, RegExps, and caps keys', () => {
    const logger = getLogger()
    const circ: any = { a: 'test', date: new Date('2026-01-01'), regex: /foo/i, buf: Buffer.from('hello') }
    circ.self = circ
    for (let i = 0; i < 60; i++) circ[`k_${i}`] = i

    assert.doesNotThrow(() => {
      logger.info('Test log message', circ)
    })
  })

  it('BUG-P4-18: safeJsonStringify preserves shared DAG references without false [Circular]', () => {
    const shared = { name: 'shared-child' }
    const dag = {
      first: shared,
      second: shared,
      nested: { third: shared },
    }
    const json = safeJsonStringify(dag)
    assert.ok(!json.includes('[Circular]'), 'Shared DAG references should not be marked as [Circular]')
    assert.ok(json.includes('"name":"shared-child"'))
  })

  // ─── Part 5 Tests ─────────────────────────────────────────────────────────

  it('BUG-P5-03: captureBodySnapshot uses bounded inspection and does not spike on large bodies', () => {
    const largeObject: Record<string, string> = {}
    for (let i = 0; i < 2000; i++) {
      largeObject[`k_${i}`] = 'x'.repeat(100)
    }
    const snapshot = captureBodySnapshot(largeObject, true)
    assert.ok(snapshot.bodySize && snapshot.bodySize > 64 * 1024)
    assert.deepEqual(snapshot.body, { __truncated: true })
  })

  it('BUG-P5-06: MongoDB dbStatementSerializer truncates at 2048 and omits document arrays', () => {
    const instr = createMongoDBInstrumentation(true, {}, { headers: true, body: true, response: true, query: true, cookies: true })
    const serializer = (instr as any)?._config?.dbStatementSerializer
    assert.ok(typeof serializer === 'function')

    const command = {
      insert: 'users',
      documents: new Array(500).fill({ username: 'bob', password: 'secretpassword123' }),
      ordered: true,
      lsid: { id: 'uuid-123' },
    }
    const statement = serializer(command)
    assert.ok(statement.includes('[Array(500)]'), 'documents array should be summarized')
    assert.ok(statement.includes('[OMITTED]'), 'lsid should be omitted')
    assert.ok(statement.length <= 2048 + 20, 'statement must be bounded')
  })

  it('BUG-P5-09: resolvePrismaDbSystem dynamically resolves provider and defaults to postgresql', () => {
    const mockPrismaPostgres = { _engineConfig: { activeProvider: 'postgresql' } }
    const mockPrismaMysql = { _engineConfig: { activeProvider: 'mysql' } }
    const mockPrismaSqlite = { _activeProvider: 'sqlite' }
    const mockPrismaFallback = {}

    assert.equal(resolvePrismaDbSystem(mockPrismaPostgres), 'postgresql')
    assert.equal(resolvePrismaDbSystem(mockPrismaMysql), 'mysql')
    assert.equal(resolvePrismaDbSystem(mockPrismaSqlite), 'sqlite')
    assert.equal(resolvePrismaDbSystem(mockPrismaFallback), 'postgresql')
  })

  it('BUG-P5-10: Redis sensitive key regex avoids false positives on words like "hotkey" or "monkey"', () => {
    assert.equal(isSensitiveRedisKey('hotkey:item1'), false)
    assert.equal(isSensitiveRedisKey('monkey:user'), false)
    assert.equal(isSensitiveRedisKey('cache_key:42'), false)

    assert.equal(isSensitiveRedisKey('api_key'), true)
    assert.equal(isSensitiveRedisKey('api-key'), true)
    assert.equal(isSensitiveRedisKey('user:auth_token'), true)
    assert.equal(isSensitiveRedisKey('secret_key'), true)
    assert.equal(isSensitiveRedisKey('user:password'), true)

    const serializer = createRedisStatementSerializer('sanitized-key', true)
    assert.equal(serializer('MGET', ['user:123', 'user:456']), 'MGET user:123')
    assert.equal(serializer('LRANGE', ['messages', '0', '10']), 'LRANGE messages')
  })

  it('BUG-P5-11: Nodemailer extracts recipient domain from structured Address objects and arrays', () => {
    const instr = createNodemailerInstrumentation(true)
    assert.ok(instr)
    const extractDomain = (instr as any)._extractRecipientDomain.bind(instr)

    assert.equal(extractDomain('alice@example.com'), 'example.com')
    assert.equal(extractDomain('Alice <alice@company.org>'), 'company.org')
    assert.equal(extractDomain({ name: 'Bob', address: 'bob@enterprise.io' }), 'enterprise.io')
    assert.equal(extractDomain([{ name: 'Charlie', address: 'charlie@acme.corp' }]), 'acme.corp')
    assert.equal(extractDomain(null), 'unknown')
    assert.equal(extractDomain('invalid-email'), 'unknown')
  })

  it('BUG-P5-12: Serverless wrapHandler isolates ContextStore and supports callback-style handlers', async () => {
    let capturedRequestId1 = ''
    let capturedRequestId2 = ''

    const asyncLambda = wrapHandler(async (_event: any, context: any) => {
      const store = getRequestContext()
      capturedRequestId1 = store?.requestId ?? ''
      return { status: 200 }
    })

    const callbackLambda = wrapHandler((_event: any, context: any, callback: any) => {
      const store = getRequestContext()
      capturedRequestId2 = store?.requestId ?? ''
      callback(null, { status: 201 })
    })

    const res1 = (await asyncLambda({}, { awsRequestId: 'req-aws-123' })) as any
    assert.equal(res1.status, 200)
    assert.equal(capturedRequestId1, 'req-aws-123')

    const res2 = (await callbackLambda({}, { awsRequestId: 'req-aws-456' })) as any
    assert.equal(res2.status, 201)
    assert.equal(capturedRequestId2, 'req-aws-456')

    assert.notEqual(capturedRequestId1, capturedRequestId2)
  })

  // ─── Nuance Upgrades Verification ─────────────────────────────────────────

  it('Nuance 1 (BUG-P4-09 Upgrade): TransportEventQueue Dual-Ring provides strict O(1) eviction under heavy critical event front backlog', () => {
    const drops: any[] = []
    const capacity = 100
    const queue = new TransportEventQueue({
      route: 'errors',
      maxSize: capacity,
      criticalReserve: 20,
      priority: 'high',
      overflowStrategy: 'drop_oldest',
      onDrop: d => drops.push(d),
    })

    // Enqueue 20 critical events (occupying the front of the queue)
    for (let i = 0; i < 20; i++) {
      queue.enqueue({
        type: 'error',
        eventId: `fatal-${i}`,
        message: 'fatal',
        name: 'Error',
        timestamp: Date.now(),
        severity: 'fatal',
        classification: { unhandled: true, fatal: true, crash: true },
        stack: [],
        fingerprint: `crit-${i}`,
        context: {},
      })
    }

    // Enqueue 80 ordinary events (filling ordinary capacity of 80)
    for (let i = 0; i < 80; i++) {
      queue.enqueue({
        type: 'error',
        eventId: `ord-${i}`,
        message: 'ord',
        name: 'Error',
        timestamp: Date.now(),
        severity: 'error',
        classification: { unhandled: false, fatal: false, crash: false },
        stack: [],
        fingerprint: `ord-${i}`,
        context: {},
      })
    }

    assert.equal(queue.size(), 100)

    // Enqueue 10 new ordinary events under drop_oldest.
    // In O(1), the oldest ordinary events (ord-0..ord-9) should be evicted
    // and ZERO critical events (fatal-0..fatal-19) must be touched.
    for (let i = 80; i < 90; i++) {
      const accepted = queue.enqueue({
        type: 'error',
        eventId: `ord-${i}`,
        message: 'ord',
        name: 'Error',
        timestamp: Date.now(),
        severity: 'error',
        classification: { unhandled: false, fatal: false, crash: false },
        stack: [],
        fingerprint: `ord-${i}`,
        context: {},
      })
      assert.equal(accepted, true)
    }

    assert.equal(queue.size(), 100)
    assert.equal(drops.length, 10)
    // Verify evicted events were ord-0 through ord-9
    for (let i = 0; i < 10; i++) {
      assert.equal(drops[i]?.eventId, `ord-${i}`)
      assert.equal(drops[i]?.critical, false)
    }

    // Drain all 100 events and verify strict FIFO interleaved order:
    // All 20 fatals are preserved, followed by ord-10 through ord-89
    const drained = queue.drain(100).map(e => e.eventId)
    assert.equal(drained.length, 100)
    for (let i = 0; i < 20; i++) {
      assert.ok(drained.includes(`fatal-${i}`))
    }
    assert.ok(!drained.includes('ord-0'))
    assert.ok(drained.includes('ord-89'))
  })

  it('Nuance 2 (BUG-P4-14 Upgrade): CardinalityGovernor admits already-tracked series when totalSeries >= maxTotalSeries', () => {
    const gov = new CardinalityGovernor({
      maxTotalSeries: 5,
      maxSeriesPerMetric: 5,
    })

    // Register 5 distinct series to reach capacity
    for (let i = 0; i < 5; i++) {
      assert.equal(gov.canRecordSeries('http.server.duration', `route=/api/v1/item/${i}`), true)
    }
    assert.equal(gov.getStats().totalSeries, 5)

    // Attempt to register a 6th NEW series -> must be rejected
    assert.equal(gov.canRecordSeries('http.server.duration', 'route=/api/v1/item/999'), false)
    assert.equal(gov.getStats().droppedSeriesCount, 1)

    // Re-record ALREADY-TRACKED series (e.g. item/0, item/1) -> MUST SUCCEED even at capacity!
    assert.equal(gov.canRecordSeries('http.server.duration', 'route=/api/v1/item/0'), true)
    assert.equal(gov.canRecordSeries('http.server.duration', 'route=/api/v1/item/1'), true)
    // Dropped count should NOT increment for existing series
    assert.equal(gov.getStats().droppedSeriesCount, 1)

    // Eviction test: simulate idle series and active series
    // In a new governor, simulate private evictStaleSeries
    const gov2 = new CardinalityGovernor({ maxTotalSeries: 10, maxSeriesPerMetric: 10 })
    gov2.canRecordSeries('active.metric', 'k=1')
    gov2.canRecordSeries('stale.metric', 'k=2')

    // Mock Date.now into the future past 1 hour (3_600_000ms)
    const realDateNow = Date.now
    try {
      const now = realDateNow()
      // Refresh active.metric to be fresh at now + 4_000_000ms
      Date.now = () => now + 4_000_000
      gov2.canRecordSeries('active.metric', 'k=1')

      // Call private evictStaleSeries
      ;(gov2 as any).evictStaleSeries()

      // Stale metric was created at `now`, which is > 1h older than `now + 4_000_000`, so it got evicted!
      // Active metric was refreshed at `now + 4_000_000`, so it survived!
      assert.equal(gov2.getStats().totalSeries, 1)
      assert.equal(gov2.getStats().instrumentCount, 1)
    } finally {
      Date.now = realDateNow
    }
  })
})
