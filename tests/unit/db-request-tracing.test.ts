import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { trace, context as otelContext, ROOT_CONTEXT, SpanKind, SpanStatusCode } from '@opentelemetry/api'
import { init, shutdown, flushTracer, getActiveSpan, startDbSpan, withDbSpan } from '../../src/index.js'
import { drainPendingEventProcessing } from '../../src/core/event-pipeline.js'
import { createMongoDBInstrumentation } from '../../src/instrumentation/mongodb.js'
import { createMySQLInstrumentation } from '../../src/instrumentation/mysql.js'
import { createPgInstrumentation } from '../../src/instrumentation/pg.js'
import { createPrismaInstrumentation } from '../../src/instrumentation/prisma.js'
import { createRedisInstrumentation } from '../../src/instrumentation/redis.js'
import { createBullMQInstrumentation } from '../../src/instrumentation/bullmq.js'
import { createGraphQLInstrumentation } from '../../src/instrumentation/graphql.js'
import { createAxiosInstrumentation } from '../../src/instrumentation/axios.js'
import { lynktraceMiddleware } from '../../src/instrumentation/express.js'
import { lynktraceFastifyPlugin } from '../../src/instrumentation/fastify.js'
import { TEST_REMOTE_CONFIG } from '../fixtures/remote-config.js'

type CapturedEvent = Record<string, any>

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

const dbSpanCases = [
    {
        label: 'pg',
        spanName: 'pg.query:SELECT users',
        kind: SpanKind.CLIENT,
        expectedKind: 'client',
        attributes: {
            'db.system': 'postgresql',
            'db.name': 'production_db',
            'db.operation': 'SELECT',
            'db.sql.table': 'users',
            'db.statement': 'SELECT * FROM users WHERE id = ?',
            'net.peer.name': 'pg-primary.internal',
            'net.peer.port': 5432,
        },
    },
    {
        label: 'mysql2',
        spanName: 'mysql.query:SELECT orders',
        kind: SpanKind.CLIENT,
        expectedKind: 'client',
        attributes: {
            'db.system': 'mysql',
            'db.name': 'commerce_db',
            'db.operation': 'SELECT',
            'db.sql.table': 'orders',
            'db.statement': 'SELECT * FROM orders WHERE customer_id = ?',
            'net.peer.name': 'mysql-replica.internal',
            'net.peer.port': 3306,
        },
    },
    {
        label: 'mongodb',
        spanName: 'mongodb.find customers',
        kind: SpanKind.CLIENT,
        expectedKind: 'client',
        attributes: {
            'db.system': 'mongodb',
            'db.name': 'crm_db',
            'db.operation': 'find',
            'db.collection': 'customers',
            'db.statement': '{"find":"customers","filter":{"tier":"platinum"}}',
            'net.peer.name': 'mongo-cluster.internal',
        },
    },
    {
        label: 'redis',
        spanName: 'redis.get session:token',
        kind: SpanKind.CLIENT,
        expectedKind: 'client',
        attributes: {
            'db.system': 'redis',
            'db.operation': 'GET',
            'db.redis.database': 0,
            'db.statement': 'GET [REDACTED]',
            'net.peer.name': 'redis-cache.internal',
            'net.peer.port': 6379,
        },
    },
    {
        label: 'prisma',
        spanName: 'prisma:client:operation User.findUnique',
        kind: SpanKind.CLIENT,
        expectedKind: 'client',
        attributes: {
            'db.system': 'prisma',
            'db.operation': 'findUnique',
            'db.name': 'app_db',
            'prisma.model': 'User',
            'db.statement': 'SELECT "User"."id", "User"."email" FROM "User" WHERE "User"."id" = $1',
        },
    },
    {
        label: 'bullmq',
        spanName: 'notifications.add send-receipt',
        kind: SpanKind.PRODUCER,
        expectedKind: 'producer',
        attributes: {
            'messaging.system': 'bullmq',
            'messaging.destination': 'notifications',
            'messaging.operation': 'add',
            'messaging.bullmq.job.name': 'send-receipt',
            'messaging.bullmq.queue.name': 'notifications',
        },
    },
    {
        label: 'graphql',
        spanName: 'graphql.execute GetCustomerProfile',
        kind: SpanKind.INTERNAL,
        expectedKind: 'internal',
        attributes: {
            'graphql.operation.name': 'GetCustomerProfile',
            'graphql.operation.type': 'query',
            'graphql.document': 'query GetCustomerProfile { customer { id name } }',
        },
    },
    {
        label: 'http_downstream',
        spanName: 'HTTP GET https://api.stripe.com/v1/charges',
        kind: SpanKind.CLIENT,
        expectedKind: 'client',
        attributes: {
            'http.method': 'GET',
            'http.url': 'https://api.stripe.com/v1/charges',
            'http.status_code': 200,
            'peer.service': 'stripe',
        },
    },
] as const

describe('DB request tracing coverage across all auto-instrumentation types', () => {
    beforeEach(() => {
        setupMockFetch()
    })

    afterEach(async () => {
        globalThis.fetch = originalFetch
        await shutdown(2_000)
    })

    it('creates every supported auto-instrumentation wrapper and validates privacy serializers', () => {
        // PG
        const pgInst = createPgInstrumentation(true, { captureQueries: true, captureParams: true }, TEST_REMOTE_CONFIG.privacy.capture)
        assert.ok(pgInst, 'pg instrumentation should instantiate')
        assert.equal(createPgInstrumentation(false), null)

        // MySQL2
        const mysqlInst = createMySQLInstrumentation(true, { captureQueries: true }, TEST_REMOTE_CONFIG.privacy.capture)
        assert.ok(mysqlInst, 'mysql2 instrumentation should instantiate')
        assert.equal(createMySQLInstrumentation(false), null)

        // MongoDB
        const mongoInst = createMongoDBInstrumentation(true, { enhancedDatabaseReporting: true }, { ...TEST_REMOTE_CONFIG.privacy.capture, body: false })
        assert.ok(mongoInst, 'mongodb instrumentation should instantiate')
        assert.equal(createMongoDBInstrumentation(false), null)

        // Test MongoDB dbStatementSerializer: privacy redaction when body is false vs true
        const mongoConfig = (mongoInst as any).getConfig()
        assert.ok(typeof mongoConfig.dbStatementSerializer === 'function')
        assert.equal(mongoConfig.dbStatementSerializer({ find: 'users', filter: { secret: '123' } }), '[REDACTED]')

        const mongoInstWithBody = createMongoDBInstrumentation(true, {}, { ...TEST_REMOTE_CONFIG.privacy.capture, body: true })
        const mongoConfigWithBody = (mongoInstWithBody as any).getConfig()
        assert.equal(
            mongoConfigWithBody.dbStatementSerializer({ find: 'users', filter: { id: '123' } }),
            '{"find":"users","filter":{"id":"123"}}'
        )

        // Redis
        const redisInst = createRedisInstrumentation(true, {}, { ...TEST_REMOTE_CONFIG.privacy.capture, body: false })
        assert.ok(redisInst, 'redis instrumentation should instantiate')
        assert.equal(createRedisInstrumentation(false), null)

        // Test Redis dbStatementSerializer: sensitive commands masked, non-sensitive arguments included
        const redisConfig = (redisInst as any).getConfig()
        assert.ok(typeof redisConfig.dbStatementSerializer === 'function')
        // When body is false: returns just command name
        assert.equal(redisConfig.dbStatementSerializer('GET', ['session:123']), 'GET')

        // When body is true: masks sensitive commands, retains non-sensitive arguments
        const redisInstWithBody = createRedisInstrumentation(true, {}, { ...TEST_REMOTE_CONFIG.privacy.capture, body: true })
        const redisConfigWithBody = (redisInstWithBody as any).getConfig()
        assert.equal(redisConfigWithBody.dbStatementSerializer('GET', ['session:123']), 'GET [REDACTED_KEY]')
        assert.equal(redisConfigWithBody.dbStatementSerializer('SET', ['token', 'secret123']), 'SET [REDACTED_KEY] [REDACTED]')
        assert.equal(redisConfigWithBody.dbStatementSerializer('PING', []), 'PING')

        // Prisma
        assert.ok(createPrismaInstrumentation({ enabled: true, captureQueries: true, captureParams: false }))
        assert.equal(createPrismaInstrumentation({ enabled: false, captureQueries: true, captureParams: false }), null)

        // BullMQ
        const bullmqInst = createBullMQInstrumentation(true, { emitCreateSpansForBulk: true, emitCreateSpansForFlow: true, requireParentSpanForPublish: true })
        assert.ok(bullmqInst, 'bullmq instrumentation should instantiate')
        assert.equal(createBullMQInstrumentation(false), null)

        // GraphQL
        const graphqlInst = createGraphQLInstrumentation({ enabled: true, captureResolvers: true }, { depthLimit: 5 })
        assert.ok(graphqlInst, 'graphql instrumentation should instantiate')
        assert.equal(createGraphQLInstrumentation({ enabled: false }), null)

        // Axios
        const axiosInst = createAxiosInstrumentation(true, { captureRequestData: true, captureResponseData: true })
        assert.ok(axiosInst, 'axios instrumentation should instantiate')
        assert.equal(createAxiosInstrumentation(false), null)
    })

    it('exports every supported DB & downstream client span as a child of an active request span and reconstructs full trace tree', async () => {
        const capturedEvents: CapturedEvent[] = []

        await init({
            apiKey: 'test-key-db-all-types',
            beforeSend: event => {
                capturedEvents.push(event)
                return event
            },
        })

        const otelTracer = trace.getTracer('pulse-sdk-test-db-all-types')
        let requestTraceId = ''
        let requestSpanId = ''
        const childSpanIds = new Map<string, string>()
        let manualWithDbSpanId = ''
        let manualStartDbSpanId = ''

        // Simulate an incoming HTTP request SERVER span
        await otelTracer.startActiveSpan(
            'HTTP GET /api/v1/checkout',
            {
                kind: SpanKind.SERVER,
                attributes: {
                    'http.method': 'GET',
                    'http.route': '/api/v1/checkout',
                    'url.path': '/api/v1/checkout',
                },
            },
            async requestSpan => {
                requestTraceId = requestSpan.spanContext().traceId
                requestSpanId = requestSpan.spanContext().spanId

                // Execute queries for all 8 auto-instrumentation types
                for (const dbCase of dbSpanCases) {
                    await otelTracer.startActiveSpan(
                        dbCase.spanName,
                        {
                            kind: dbCase.kind,
                            attributes: dbCase.attributes,
                        },
                        async childSpan => {
                            const childSpanId = childSpan.spanContext().spanId
                            childSpanIds.set(dbCase.label, childSpanId)
                            assert.equal(childSpan.spanContext().traceId, requestTraceId, `${dbCase.label} should inherit request traceId`)
                            // Simulate async operation duration
                            await new Promise(r => setTimeout(r, 5))
                            childSpan.end()
                        },
                    )
                }

                await withDbSpan(
                    {
                        system: 'postgresql',
                        operation: 'SELECT',
                        database: 'production_db',
                        table: 'invoices',
                        statement: 'SELECT * FROM invoices WHERE request_id = $1',
                    },
                    async span => {
                        manualWithDbSpanId = span.spanId
                        assert.equal(span.traceId, requestTraceId, 'withDbSpan should inherit request traceId')
                        assert.equal(span.parentSpanId, requestSpanId, 'withDbSpan should expose request parentSpanId')
                        await Promise.resolve()
                    },
                )

                const manualSpan = startDbSpan({
                    system: 'redis',
                    operation: 'GET',
                    database: '0',
                    statement: 'GET [REDACTED]',
                })
                manualStartDbSpanId = manualSpan.spanId
                assert.equal(manualSpan.traceId, requestTraceId, 'startDbSpan should inherit request traceId')
                assert.equal(manualSpan.parentSpanId, requestSpanId, 'startDbSpan should expose request parentSpanId')
                manualSpan.end()

                requestSpan.end()
            },
        )

        await flushTracer()
        await drainPendingEventProcessing()

        const spanEvents = capturedEvents.filter(event => event.type === 'span')
        const requestEvent = spanEvents.find(event => event.spanId === requestSpanId)

        assert.ok(requestEvent, 'request/server span should be exported')
        assert.equal(requestEvent.kind, 'server')

        // Verify each individual child span
        for (const dbCase of dbSpanCases) {
            const childSpanId = childSpanIds.get(dbCase.label)
            const spanEvent = spanEvents.find(event => event.spanId === childSpanId)

            assert.ok(spanEvent, `${dbCase.label} child span should be exported`)
            assert.equal(spanEvent.traceId, requestTraceId, `${dbCase.label} traceId must match requestTraceId`)
            assert.equal(spanEvent.parentSpanId, requestSpanId, `${dbCase.label} parentSpanId must match requestSpanId`)
            assert.equal(spanEvent.kind, dbCase.expectedKind, `${dbCase.label} span kind must match expected kind`)

            // Verify specific attributes
            for (const [key, value] of Object.entries(dbCase.attributes)) {
                assert.equal(spanEvent.attributes[key], value, `${dbCase.label} attribute ${key} must match`)
            }
        }

        for (const [label, spanId] of [
            ['withDbSpan', manualWithDbSpanId],
            ['startDbSpan', manualStartDbSpanId],
        ] as const) {
            const manualSpanEvent = spanEvents.find(event => event.spanId === spanId)

            assert.ok(manualSpanEvent, `${label} manual DB span should be exported`)
            assert.equal(manualSpanEvent.traceId, requestTraceId, `${label} traceId must match requestTraceId`)
            assert.equal(manualSpanEvent.parentSpanId, requestSpanId, `${label} parentSpanId must match requestSpanId`)
            assert.equal(manualSpanEvent.kind, 'client', `${label} span kind must be client`)
            assert.ok(manualSpanEvent.attributes['db.system'], `${label} must include db.system`)
            assert.ok(manualSpanEvent.attributes['db.operation'], `${label} must include db.operation`)
        }

        // Verify the aggregated trace tree
        const traceEvent = capturedEvents.find(event => event.type === 'trace' && event.traceId === requestTraceId)
        assert.ok(traceEvent, 'complete trace event should be exported by TraceAggregator')
        assert.equal(traceEvent.rootSpan.spanId, requestSpanId)
        assert.equal(traceEvent.isPartial, false)
        assert.equal(traceEvent.spanCount, dbSpanCases.length + 3)

        // Verify children array in rootSpan
        const aggregatedChildren = traceEvent.rootSpan.children
        assert.equal(aggregatedChildren.length, dbSpanCases.length + 2, 'rootSpan should have all child spans in children array')

        const aggregatedSpanIds = new Set(aggregatedChildren.map((c: any) => c.spanId))
        for (const dbCase of dbSpanCases) {
            assert.ok(
                aggregatedSpanIds.has(childSpanIds.get(dbCase.label)),
                `${dbCase.label} should be present in rootSpan.children`,
            )
        }
        assert.ok(aggregatedSpanIds.has(manualWithDbSpanId), 'withDbSpan should be present in rootSpan.children')
        assert.ok(aggregatedSpanIds.has(manualStartDbSpanId), 'startDbSpan should be present in rootSpan.children')

        // Verify exclusiveDuration computation (root duration minus child intervals)
        assert.ok(
            typeof traceEvent.rootSpan.exclusiveDuration === 'number',
            'rootSpan should have exclusiveDuration calculated',
        )
        assert.ok(
            traceEvent.rootSpan.exclusiveDuration <= traceEvent.rootSpan.duration,
            'root exclusiveDuration should be <= total duration',
        )
    })

    it('captures database queries initiated within Express lynktraceMiddleware request lifecycle', async () => {
        const capturedEvents: CapturedEvent[] = []

        await init({
            apiKey: 'test-key-express-db-tracing',
            beforeSend: event => {
                capturedEvents.push(event)
                return event
            },
        })

        const middleware = lynktraceMiddleware()
        const req: any = {
            method: 'GET',
            url: '/api/users/profile',
            path: '/api/users/profile',
            originalUrl: '/api/users/profile',
            headers: {
                'x-request-id': 'req-express-db-123',
                'user-agent': 'node-test',
            },
        }

        const listeners: Record<string, Function> = {}
        const res: any = {
            statusCode: 200,
            getHeader: () => undefined,
            once: (event: string, cb: Function) => {
                listeners[event] = cb
            },
            on: () => res,
            emit: () => true,
        }

        const otelTracer = trace.getTracer('pulse-sdk-express-db-test')
        let serverTraceId = ''
        let serverSpanId = ''
        let pgChildSpanId = ''
        let redisChildSpanId = ''

        await new Promise<void>((resolve, reject) => {
            middleware(req, res, async () => {
                try {
                    const activeSpan = trace.getActiveSpan()
                    assert.ok(activeSpan, 'Express middleware must establish an active span in context')
                    serverTraceId = activeSpan.spanContext().traceId
                    serverSpanId = activeSpan.spanContext().spanId

                    // Database query 1: PostgreSQL query inside route handler
                    await otelTracer.startActiveSpan(
                        'pg.query:SELECT users',
                        {
                            kind: SpanKind.CLIENT,
                            attributes: {
                                'db.system': 'postgresql',
                                'db.name': 'app_db',
                                'db.operation': 'SELECT',
                                'db.sql.table': 'users',
                                'db.statement': 'SELECT * FROM users WHERE id = $1',
                            },
                        },
                        async dbSpan => {
                            pgChildSpanId = dbSpan.spanContext().spanId
                            assert.equal(dbSpan.spanContext().traceId, serverTraceId)
                            await new Promise(r => setTimeout(r, 10))
                            dbSpan.end()
                        },
                    )

                    // Database query 2: Redis cache check inside route handler
                    await otelTracer.startActiveSpan(
                        'redis.get user:123:cache',
                        {
                            kind: SpanKind.CLIENT,
                            attributes: {
                                'db.system': 'redis',
                                'db.operation': 'GET',
                                'db.redis.database': 0,
                                'db.statement': 'GET [REDACTED]',
                            },
                        },
                        async cacheSpan => {
                            redisChildSpanId = cacheSpan.spanContext().spanId
                            assert.equal(cacheSpan.spanContext().traceId, serverTraceId)
                            await new Promise(r => setTimeout(r, 5))
                            cacheSpan.end()
                        },
                    )

                    resolve()
                } catch (err) {
                    reject(err)
                }
            })
        })

        // Simulate response finish
        if (listeners['finish']) {
            listeners['finish']()
        }

        await flushTracer()
        await drainPendingEventProcessing()

        const spanEvents = capturedEvents.filter(event => event.type === 'span')
        const pgEvent = spanEvents.find(event => event.spanId === pgChildSpanId)
        const redisEvent = spanEvents.find(event => event.spanId === redisChildSpanId)

        assert.ok(pgEvent, 'pg span should be exported')
        assert.equal(pgEvent.parentSpanId, serverSpanId, 'pg span must be parented to Express server span')
        assert.equal(pgEvent.traceId, serverTraceId, 'pg span traceId must match Express server traceId')
        assert.equal(pgEvent.attributes['db.system'], 'postgresql')

        assert.ok(redisEvent, 'redis span should be exported')
        assert.equal(redisEvent.parentSpanId, serverSpanId, 'redis span must be parented to Express server span')
        assert.equal(redisEvent.traceId, serverTraceId, 'redis span traceId must match Express server traceId')
        assert.equal(redisEvent.attributes['db.system'], 'redis')

        // Verify trace aggregation tree
        const traceEvent = capturedEvents.find(event => event.type === 'trace' && event.traceId === serverTraceId)
        assert.ok(traceEvent, 'trace event should be aggregated')
        assert.equal(traceEvent.rootSpan.spanId, serverSpanId)
        const children = traceEvent.rootSpan.children
        assert.equal(children.length, 2, 'root span should have both DB spans as children')
        assert.ok(children.some((c: any) => c.spanId === pgChildSpanId))
        assert.ok(children.some((c: any) => c.spanId === redisChildSpanId))
    })

    it('captures manual DB spans inside a request even when DB auto-instrumentation is disabled', async () => {
        const capturedEvents: CapturedEvent[] = []

        await init({
            apiKey: 'test-key-manual-db-without-auto',
            beforeSend: event => {
                capturedEvents.push(event)
                return event
            },
        })

        const middleware = lynktraceMiddleware()
        const req: any = {
            method: 'GET',
            url: '/api/manual-db',
            path: '/api/manual-db',
            originalUrl: '/api/manual-db',
            headers: {
                'x-request-id': 'req-manual-db-123',
            },
        }
        const listeners: Record<string, Function> = {}
        const res: any = {
            statusCode: 200,
            getHeader: () => undefined,
            once: (event: string, cb: Function) => {
                listeners[event] = cb
            },
            on: () => res,
            emit: () => true,
        }

        let serverTraceId = ''
        let serverSpanId = ''
        let pgSpanId = ''
        let redisSpanId = ''

        await new Promise<void>((resolve, reject) => {
            middleware(req, res, async () => {
                try {
                    const activeSpan = trace.getActiveSpan()
                    assert.ok(activeSpan, 'request middleware should create an active fallback server span')
                    serverTraceId = activeSpan.spanContext().traceId
                    serverSpanId = activeSpan.spanContext().spanId

                    await withDbSpan(
                        {
                            system: 'postgresql',
                            operation: 'SELECT',
                            database: 'app_db',
                            table: 'users',
                            statement: 'SELECT * FROM users WHERE id = $1',
                        },
                        async span => {
                            pgSpanId = span.spanId
                            await Promise.resolve()
                        },
                    )

                    const redisSpan = startDbSpan({
                        system: 'redis',
                        operation: 'GET',
                        database: '0',
                        statement: 'GET [REDACTED]',
                    })
                    redisSpanId = redisSpan.spanId
                    redisSpan.end()

                    resolve()
                } catch (err) {
                    reject(err)
                }
            })
        })

        listeners['finish']?.()

        await flushTracer()
        await drainPendingEventProcessing()

        const spanEvents = capturedEvents.filter(event => event.type === 'span')
        const pgEvent = spanEvents.find(event => event.spanId === pgSpanId)
        const redisEvent = spanEvents.find(event => event.spanId === redisSpanId)

        assert.ok(pgEvent, 'withDbSpan should export a PostgreSQL span without auto-instrumentation')
        assert.equal(pgEvent.traceId, serverTraceId)
        assert.equal(pgEvent.parentSpanId, serverSpanId)
        assert.equal(pgEvent.kind, 'client')
        assert.equal(pgEvent.attributes['db.system'], 'postgresql')
        assert.equal(pgEvent.attributes['db.sql.table'], 'users')

        assert.ok(redisEvent, 'startDbSpan should export a Redis span without auto-instrumentation')
        assert.equal(redisEvent.traceId, serverTraceId)
        assert.equal(redisEvent.parentSpanId, serverSpanId)
        assert.equal(redisEvent.kind, 'client')
        assert.equal(redisEvent.attributes['db.system'], 'redis')

        const traceEvent = capturedEvents.find(event => event.type === 'trace' && event.traceId === serverTraceId)
        assert.ok(traceEvent, 'manual DB spans should be present in the aggregate request trace')
        const children = new Set(traceEvent.rootSpan.children.map((child: CapturedEvent) => child.spanId))
        assert.ok(children.has(pgSpanId))
        assert.ok(children.has(redisSpanId))
    })

    it('keeps manual DB spans attached when async context is lost but an explicit parent is supplied', async () => {
        const capturedEvents: CapturedEvent[] = []

        await init({
            apiKey: 'test-key-manual-db-explicit-parent',
            beforeSend: event => {
                capturedEvents.push(event)
                return event
            },
        })

        const middleware = lynktraceMiddleware()
        const req: any = {
            method: 'GET',
            url: '/api/context-lost',
            path: '/api/context-lost',
            originalUrl: '/api/context-lost',
            headers: {
                'x-request-id': 'req-context-lost-123',
            },
        }
        const listeners: Record<string, Function> = {}
        const res: any = {
            statusCode: 200,
            getHeader: () => undefined,
            once: (event: string, cb: Function) => {
                listeners[event] = cb
            },
            on: () => res,
            emit: () => true,
        }

        let serverTraceId = ''
        let serverSpanId = ''
        let pgSpanId = ''
        let redisSpanId = ''

        await new Promise<void>((resolve, reject) => {
            middleware(req, res, async () => {
                try {
                    const requestSpan = getActiveSpan()
                    assert.ok(requestSpan, 'request middleware should expose an active Pulse span')
                    serverTraceId = requestSpan.traceId
                    serverSpanId = requestSpan.spanId

                    await otelContext.with(ROOT_CONTEXT, async () => {
                        assert.equal(trace.getActiveSpan(), undefined, 'test must simulate a lost active OTel context')

                        await withDbSpan(
                            {
                                system: 'postgresql',
                                operation: 'SELECT',
                                table: 'accounts',
                                parent: requestSpan,
                            },
                            async span => {
                                pgSpanId = span.spanId
                                assert.equal(span.traceId, serverTraceId)
                                assert.equal(span.parentSpanId, serverSpanId)
                            },
                        )

                        const redisSpan = startDbSpan({
                            system: 'redis',
                            operation: 'GET',
                            parent: requestSpan.spanContext(),
                        })
                        redisSpanId = redisSpan.spanId
                        assert.equal(redisSpan.traceId, serverTraceId)
                        assert.equal(redisSpan.parentSpanId, serverSpanId)
                        redisSpan.end()
                    })

                    resolve()
                } catch (err) {
                    reject(err)
                }
            })
        })

        listeners['finish']?.()

        await flushTracer()
        await drainPendingEventProcessing()

        const spanEvents = capturedEvents.filter(event => event.type === 'span')
        const pgEvent = spanEvents.find(event => event.spanId === pgSpanId)
        const redisEvent = spanEvents.find(event => event.spanId === redisSpanId)

        assert.ok(pgEvent, 'withDbSpan should export with explicit parent when active context is missing')
        assert.equal(pgEvent.traceId, serverTraceId)
        assert.equal(pgEvent.parentSpanId, serverSpanId)
        assert.equal(pgEvent.kind, 'client')

        assert.ok(redisEvent, 'startDbSpan should export with explicit parent when active context is missing')
        assert.equal(redisEvent.traceId, serverTraceId)
        assert.equal(redisEvent.parentSpanId, serverSpanId)
        assert.equal(redisEvent.kind, 'client')

        const traceEvent = capturedEvents.find(event => event.type === 'trace' && event.traceId === serverTraceId)
        assert.ok(traceEvent, 'explicitly-parented DB spans should be present in the aggregate request trace')
        const children = new Set(traceEvent.rootSpan.children.map((child: CapturedEvent) => child.spanId))
        assert.ok(children.has(pgSpanId))
        assert.ok(children.has(redisSpanId))
    })

    it('captures database queries initiated within Fastify plugin lifecycle', async () => {
        const capturedEvents: CapturedEvent[] = []

        await init({
            apiKey: 'test-key-fastify-db-tracing',
            beforeSend: event => {
                capturedEvents.push(event)
                return event
            },
        })

        // Simulate Fastify hook lifecycle using mock Fastify instance
        const hooks: Record<string, Function[]> = {}
        const mockFastify: any = {
            addHook: (name: string, fn: Function) => {
                hooks[name] = hooks[name] || []
                hooks[name].push(fn)
            },
        }

        lynktraceFastifyPlugin(mockFastify, {}, () => {})

        const request: any = {
            method: 'GET',
            url: '/orders/101',
            headers: {
                'x-request-id': 'fastify-req-101',
            },
        }
        const reply: any = {
            statusCode: 200,
            send: (payload: any) => payload,
        }

        // Trigger onRequest
        assert.ok(hooks['onRequest']?.[0], 'onRequest hook should be registered')
        await new Promise<void>(resolve => {
            hooks['onRequest']![0]!(request, reply, () => resolve())
        })

        const otelTracer = trace.getTracer('pulse-sdk-fastify-db-test')
        let fastifyTraceId = ''
        let fastifyServerSpanId = ''
        let mongoSpanId = ''

        // Trigger preHandler and run DB queries in the route handler scope
        assert.ok(hooks['preHandler']?.[0], 'preHandler hook should be registered')
        await new Promise<void>(resolve => {
            hooks['preHandler']![0]!(request, reply, async () => {
                const activeSpan = trace.getActiveSpan()
                assert.ok(activeSpan, 'Fastify plugin must establish active span in preHandler')
                fastifyTraceId = activeSpan.spanContext().traceId
                fastifyServerSpanId = activeSpan.spanContext().spanId

                // Downstream MongoDB query inside Fastify route
                await otelTracer.startActiveSpan(
                    'mongodb.find orders',
                    {
                        kind: SpanKind.CLIENT,
                        attributes: {
                            'db.system': 'mongodb',
                            'db.name': 'order_service',
                            'db.operation': 'find',
                            'db.collection': 'orders',
                            'db.statement': '{"find":"orders","filter":{"id":101}}',
                        },
                    },
                    async mongoSpan => {
                        mongoSpanId = mongoSpan.spanContext().spanId
                        assert.equal(mongoSpan.spanContext().traceId, fastifyTraceId)
                        await new Promise(r => setTimeout(r, 10))
                        mongoSpan.end()
                    },
                )

                resolve()
            })
        })

        // Trigger onResponse
        assert.ok(hooks['onResponse']?.[0], 'onResponse hook should be registered')
        await new Promise<void>(resolve => {
            hooks['onResponse']![0]!(request, reply, () => resolve())
        })

        await flushTracer()
        await drainPendingEventProcessing()

        const spanEvents = capturedEvents.filter(event => event.type === 'span')
        const mongoEvent = spanEvents.find(event => event.spanId === mongoSpanId)

        assert.ok(mongoEvent, 'mongodb span should be exported')
        assert.equal(mongoEvent.parentSpanId, fastifyServerSpanId, 'mongodb span must be parented to Fastify server span')
        assert.equal(mongoEvent.traceId, fastifyTraceId, 'mongodb span traceId must match Fastify server traceId')
        assert.equal(mongoEvent.attributes['db.system'], 'mongodb')
        assert.equal(mongoEvent.attributes['db.collection'], 'orders')
    })

    it('maintains strict isolation between concurrent requests with interleaved DB queries (zero context bleeding)', async () => {
        const capturedEvents: CapturedEvent[] = []

        await init({
            apiKey: 'test-key-concurrency-db',
            beforeSend: event => {
                capturedEvents.push(event)
                return event
            },
        })

        const otelTracer = trace.getTracer('pulse-sdk-concurrency-test')

        let reqATraceId = ''
        let reqASpanId = ''
        let reqAMongoSpanId = ''
        let reqARedisSpanId = ''

        let reqBTraceId = ''
        let reqBSpanId = ''
        let reqBPgSpanId = ''
        let reqBPrismaSpanId = ''

        // Run two concurrent requests with interleaved async delays
        const runRequestA = async () => {
            await otelTracer.startActiveSpan(
                'HTTP GET /orders/999',
                { kind: SpanKind.SERVER, attributes: { 'http.route': '/orders/999' } },
                async spanA => {
                    reqATraceId = spanA.spanContext().traceId
                    reqASpanId = spanA.spanContext().spanId

                    // MongoDB query (takes 25ms)
                    await otelTracer.startActiveSpan(
                        'mongodb.find orders',
                        { kind: SpanKind.CLIENT, attributes: { 'db.system': 'mongodb', 'db.collection': 'orders' } },
                        async mSpan => {
                            reqAMongoSpanId = mSpan.spanContext().spanId
                            await new Promise(r => setTimeout(r, 25))
                            mSpan.end()
                        },
                    )

                    // Redis query (takes 10ms)
                    await otelTracer.startActiveSpan(
                        'redis.get order:999',
                        { kind: SpanKind.CLIENT, attributes: { 'db.system': 'redis', 'db.operation': 'GET' } },
                        async rSpan => {
                            reqARedisSpanId = rSpan.spanContext().spanId
                            await new Promise(r => setTimeout(r, 10))
                            rSpan.end()
                        },
                    )

                    spanA.end()
                },
            )
        }

        const runRequestB = async () => {
            await otelTracer.startActiveSpan(
                'HTTP GET /users/42',
                { kind: SpanKind.SERVER, attributes: { 'http.route': '/users/42' } },
                async spanB => {
                    reqBTraceId = spanB.spanContext().traceId
                    reqBSpanId = spanB.spanContext().spanId

                    // PostgreSQL query (takes 15ms)
                    await otelTracer.startActiveSpan(
                        'pg.query:SELECT users',
                        { kind: SpanKind.CLIENT, attributes: { 'db.system': 'postgresql', 'db.sql.table': 'users' } },
                        async pgSpan => {
                            reqBPgSpanId = pgSpan.spanContext().spanId
                            await new Promise(r => setTimeout(r, 15))
                            pgSpan.end()
                        },
                    )

                    // Prisma query (takes 15ms)
                    await otelTracer.startActiveSpan(
                        'prisma:client:operation User.findFirst',
                        { kind: SpanKind.CLIENT, attributes: { 'db.system': 'prisma', 'prisma.model': 'User' } },
                        async pSpan => {
                            reqBPrismaSpanId = pSpan.spanContext().spanId
                            await new Promise(r => setTimeout(r, 15))
                            pSpan.end()
                        },
                    )

                    spanB.end()
                },
            )
        }

        await Promise.all([runRequestA(), runRequestB()])

        await flushTracer()
        await drainPendingEventProcessing()

        // Verify traces are distinct
        assert.notEqual(reqATraceId, reqBTraceId, 'Concurrent requests must have different trace IDs')

        const traces = capturedEvents.filter(event => event.type === 'trace')
        const traceA = traces.find(t => t.traceId === reqATraceId)
        const traceB = traces.find(t => t.traceId === reqBTraceId)

        assert.ok(traceA, 'Trace A must be aggregated')
        assert.ok(traceB, 'Trace B must be aggregated')

        // Trace A must ONLY have Mongo and Redis spans
        const traceAChildIds = traceA.rootSpan.children.map((c: any) => c.spanId)
        assert.equal(traceAChildIds.length, 2)
        assert.ok(traceAChildIds.includes(reqAMongoSpanId), 'Trace A must contain reqAMongoSpanId')
        assert.ok(traceAChildIds.includes(reqARedisSpanId), 'Trace A must contain reqARedisSpanId')
        assert.ok(!traceAChildIds.includes(reqBPgSpanId), 'Trace A must NOT contain reqBPgSpanId')
        assert.ok(!traceAChildIds.includes(reqBPrismaSpanId), 'Trace A must NOT contain reqBPrismaSpanId')

        // Trace B must ONLY have Postgres and Prisma spans
        const traceBChildIds = traceB.rootSpan.children.map((c: any) => c.spanId)
        assert.equal(traceBChildIds.length, 2)
        assert.ok(traceBChildIds.includes(reqBPgSpanId), 'Trace B must contain reqBPgSpanId')
        assert.ok(traceBChildIds.includes(reqBPrismaSpanId), 'Trace B must contain reqBPrismaSpanId')
        assert.ok(!traceBChildIds.includes(reqAMongoSpanId), 'Trace B must NOT contain reqAMongoSpanId')
        assert.ok(!traceBChildIds.includes(reqARedisSpanId), 'Trace B must NOT contain reqARedisSpanId')
    })

    it('correctly handles and attributes database query errors with status ERROR and exception events', async () => {
        const capturedEvents: CapturedEvent[] = []

        await init({
            apiKey: 'test-key-db-errors',
            beforeSend: event => {
                capturedEvents.push(event)
                return event
            },
        })

        const otelTracer = trace.getTracer('pulse-sdk-db-error-test')
        let serverTraceId = ''
        let serverSpanId = ''
        let failedDbSpanId = ''

        await otelTracer.startActiveSpan(
            'HTTP POST /api/checkout',
            { kind: SpanKind.SERVER, attributes: { 'http.route': '/api/checkout' } },
            async requestSpan => {
                serverTraceId = requestSpan.spanContext().traceId
                serverSpanId = requestSpan.spanContext().spanId

                try {
                    await otelTracer.startActiveSpan(
                        'pg.query:INSERT payment',
                        {
                            kind: SpanKind.CLIENT,
                            attributes: {
                                'db.system': 'postgresql',
                                'db.operation': 'INSERT',
                                'db.sql.table': 'payments',
                                'db.statement': 'INSERT INTO payments (id, amount) VALUES ($1, $2)',
                            },
                        },
                        async dbSpan => {
                            failedDbSpanId = dbSpan.spanContext().spanId

                            // Simulate a PostgreSQL constraint violation error
                            const dbErr = new Error('duplicate key value violates unique constraint "payments_pkey"')
                            ;(dbErr as any).code = '23505'

                            dbSpan.recordException(dbErr)
                            dbSpan.setStatus({
                                code: SpanStatusCode.ERROR,
                                message: dbErr.message,
                            })
                            dbSpan.end()
                            throw dbErr
                        },
                    )
                } catch {
                    // Handled error inside request handler
                }

                requestSpan.end()
            },
        )

        await flushTracer()
        await drainPendingEventProcessing()

        const spanEvents = capturedEvents.filter(event => event.type === 'span')
        const failedDbEvent = spanEvents.find(event => event.spanId === failedDbSpanId)

        assert.ok(failedDbEvent, 'failed DB span should be exported')
        assert.equal(failedDbEvent.status, 'error', 'failed DB span status must be "error"')
        assert.equal(failedDbEvent.statusMessage, 'duplicate key value violates unique constraint "payments_pkey"')
        assert.equal(failedDbEvent.parentSpanId, serverSpanId, 'failed DB span must retain parentSpanId')
        assert.equal(failedDbEvent.traceId, serverTraceId, 'failed DB span must retain traceId')

        // Verify exception event was captured on span
        const exceptionEvent = failedDbEvent.events?.find((e: any) => e.name === 'exception')
        assert.ok(exceptionEvent, 'exception event must be recorded on failed DB span')
        assert.equal(exceptionEvent.attributes['exception.message'], 'duplicate key value violates unique constraint "payments_pkey"')

        // Verify TraceAggregator tree preserves error status
        const traceEvent = capturedEvents.find(event => event.type === 'trace' && event.traceId === serverTraceId)
        assert.ok(traceEvent, 'trace event should be aggregated')
        const childInTree = traceEvent.rootSpan.children.find((c: any) => c.spanId === failedDbSpanId)
        assert.ok(childInTree, 'failed DB span must be in rootSpan.children')
        assert.equal(childInTree.status, 'error')
    })
})
