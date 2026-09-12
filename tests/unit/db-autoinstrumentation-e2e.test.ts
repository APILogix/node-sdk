import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { trace, SpanKind, SpanStatusCode } from '@opentelemetry/api'
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node'
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { MongooseInstrumentation } from '../../src/instrumentation/mongoose.js'
import { PulsePrismaInstrumentation, instrumentPrismaClientInstance } from '../../src/instrumentation/prisma.js'

describe('End-to-End Sign-In Autoinstrumentation & Span Hierarchy Test', () => {
  let memoryExporter: InMemorySpanExporter
  let provider: NodeTracerProvider
  let mongooseInstrumentation: MongooseInstrumentation
  let prismaInstrumentation: PulsePrismaInstrumentation

  beforeEach(() => {
    memoryExporter = new InMemorySpanExporter()
    provider = new NodeTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(memoryExporter)],
    })
    provider.register()

    mongooseInstrumentation = new MongooseInstrumentation({ enabled: true })
    mongooseInstrumentation.setTracerProvider(provider)
    mongooseInstrumentation.enable()

    prismaInstrumentation = new PulsePrismaInstrumentation({ enabled: true, captureQueries: true, captureParams: false })
    prismaInstrumentation.setTracerProvider(provider)
    prismaInstrumentation.enable()
  })

  afterEach(() => {
    mongooseInstrumentation.disable()
    prismaInstrumentation.disable()
    trace.disable()
  })

  it('captures every Mongoose and Prisma operation under the request handler with correct traceId and parentSpanId', async () => {
    // 1. Setup Mock Mongoose
    const mockMongoose = {
      Query: class MockQuery {
        op = 'find'
        model = { modelName: 'User', collection: { name: 'users' }, db: { name: 'cubicle_db' } }
        _conditions = {}
        constructor(op = 'find', modelName = 'User', collectionName = 'users') {
          this.op = op
          this.model = { modelName, collection: { name: collectionName }, db: { name: 'cubicle_db' } }
        }
        getFilter() { return this._conditions }
        async exec() {
          return { id: 'usr_1', email: 'test@cubicle.com' }
        }
      },
      Model: class MockModel {
        isNew = false
        collection = { name: 'users' }
        db = { name: 'cubicle_db' }
        constructor(modelName = 'User', collectionName = 'users') {
          ;(this as any).constructor.modelName = modelName
          this.collection = { name: collectionName }
        }
        async save() {
          return this
        }
        static async create(doc: any) {
          const m = new (this as any)()
          await m.save()
          return m
        }
        static async populate(docs: any) {
          return docs
        }
      },
      Aggregate: class MockAggregate {
        model() {
          return { modelName: 'AggregateModel', collection: { name: 'agg' }, db: { name: 'cubicle_db' } }
        }
        async exec() {
          return [{ count: 1 }]
        }
      },
    }
    ;(mongooseInstrumentation as any)._patchMongoose(mockMongoose)

    // 2. Setup Mock Prisma Client with $extends & $transaction
    const rawPrisma = {
      adminSecurityPolicy: {
        findUnique: async () => ({ id: 'policy_1', version: 2, mfaEnforced: false }),
      },
      ssoConnection: {
        count: async () => 0,
      },
      async $transaction(fn: (tx: any) => Promise<any>) {
        return fn(this)
      },
      $extends(ext: any) {
        const queryHandler = ext.query?.$allModels?.$allOperations
        const self = this
        const extendedClient = {
          adminSecurityPolicy: {
            findUnique: async (args: any) => {
              if (queryHandler) {
                return queryHandler({
                  model: 'AdminSecurityPolicy',
                  operation: 'findUnique',
                  args,
                  query: () => self.adminSecurityPolicy.findUnique(),
                })
              }
              return self.adminSecurityPolicy.findUnique()
            },
          },
          ssoConnection: {
            count: async (args: any) => {
              if (queryHandler) {
                return queryHandler({
                  model: 'SsoConnection',
                  operation: 'count',
                  args,
                  query: () => self.ssoConnection.count(),
                })
              }
              return self.ssoConnection.count()
            },
          },
          async $transaction(fn: (tx: any) => Promise<any>) {
            return fn(extendedClient)
          },
        }
        return extendedClient
      },
    }

    const prisma = instrumentPrismaClientInstance(rawPrisma)

    // 3. Execute HTTP Server Span & Request Handler Span
    const httpTracer = trace.getTracer('pulse-express-test')
    await httpTracer.startActiveSpan('POST /api/auth/signin', { kind: SpanKind.SERVER }, async (rootHttpSpan) => {
      const rootCtx = rootHttpSpan.spanContext()

      await httpTracer.startActiveSpan('request handler - /api/auth/signin', { kind: SpanKind.INTERNAL }, async (handlerSpan) => {
        const handlerCtx = handlerSpan.spanContext()

        // ── Operation 1: User.findOne (Mongoose) ──────────────────
        const userQuery = new mockMongoose.Query('findOne', 'User', 'users')
        await userQuery.exec()

        // ── Operation 2: user.save (reset login attempts) ─────────
        const userDoc = new mockMongoose.Model('User', 'users')
        await userDoc.save()

        // ── Operation 3: OrgMember.findOne ────────────────────────
        const memberQuery = new mockMongoose.Query('findOne', 'OrgMember', 'orgmembers')
        await memberQuery.exec()

        // ── Operation 4: MembershipAccess.findOne ─────────────────
        const accessQuery = new mockMongoose.Query('findOne', 'MembershipAccess', 'membershipaccesses')
        await accessQuery.exec()

        // ── Operation 5: RolePermission.find ──────────────────────
        const roleQuery = new mockMongoose.Query('find', 'RolePermission', 'rolepermissions')
        await roleQuery.exec()

        // ── Operation 6: Prisma adminSecurityPolicy.findUnique (in tx) ──
        await prisma.$transaction(async (tx: any) => {
          await tx.adminSecurityPolicy.findUnique({ where: { organizationId: 'org_1' } })
          await tx.ssoConnection.count({ where: { organizationId: 'org_1', status: 'active' } })
        })

        // ── Operation 7: TrustedDevice.findOne ────────────────────
        const trustedQuery = new mockMongoose.Query('findOne', 'TrustedDevice', 'trusteddevices')
        await trustedQuery.exec()

        // ── Operation 8: Session.findOne ──────────────────────────
        const sessionQuery = new mockMongoose.Query('findOne', 'Session', 'sessions')
        await sessionQuery.exec()

        // ── Operation 9: Session.create (Mongoose static create) ───
        ;(mockMongoose.Model as any).modelName = 'Session'
        ;(mockMongoose.Model as any).collection = { name: 'sessions' }
        await mockMongoose.Model.create({ userId: 'usr_1' })

        // ── Operation 10: session.save ────────────────────────────
        const sessionDoc = new mockMongoose.Model('Session', 'sessions')
        await sessionDoc.save()

        // ── Operation 11: Parallel Org.find & MembershipAccess.find ─
        await Promise.all([
          new mockMongoose.Query('find', 'Org', 'organizations').exec(),
          new mockMongoose.Query('find', 'MembershipAccess', 'membershipaccesses').exec(),
        ])

        // ── Operation 12: Model.populate ──────────────────────────
        await mockMongoose.Model.populate([{ id: 'usr_1' }])

        // ── Operation 13: LoginHistory.create (Mongoose static) ───
        ;(mockMongoose.Model as any).modelName = 'LoginHistory'
        ;(mockMongoose.Model as any).collection = { name: 'loginhistories' }
        await mockMongoose.Model.create({ organizationId: 'org_1', userId: 'usr_1' })

        handlerSpan.end()
      })

      rootHttpSpan.end()
    })

    const finishedSpans = memoryExporter.getFinishedSpans()

    // 4. Assert Trace Correctness
    const rootSpan = finishedSpans.find((s) => s.name === 'POST /api/auth/signin')
    assert.ok(rootSpan, 'Root HTTP span must exist')
    const traceId = rootSpan.spanContext().traceId

    const handlerSpan = finishedSpans.find((s) => s.name === 'request handler - /api/auth/signin')
    assert.ok(handlerSpan, 'Request handler span must exist')
    assert.equal(handlerSpan.spanContext().traceId, traceId, 'Handler traceId must match root')
    assert.equal((handlerSpan as any).parentSpanContext?.spanId, rootSpan.spanContext().spanId, 'Handler parent must be root')

    // Find database spans
    const dbSpans = finishedSpans.filter((s) => s.attributes['db.system'] === 'mongodb' || s.attributes['db.system'] === 'postgresql')
    assert.ok(dbSpans.length >= 13, `Must record all database operations (found ${dbSpans.length})`)

    // Verify EVERY database span belongs to the same trace and has handlerSpan as parent
    for (const span of dbSpans) {
      assert.equal(
        span.spanContext().traceId,
        traceId,
        `Span ${span.name} must belong to trace ${traceId}`
      )
      assert.equal(
        (span as any).parentSpanContext?.spanId,
        handlerSpan.spanContext().spanId,
        `Span ${span.name} parent must be request handler ${handlerSpan.spanContext().spanId}`
      )
      assert.equal(span.kind, SpanKind.CLIENT, `Span ${span.name} kind must be CLIENT`)
    }

    // Verify individual Mongoose spans
    assert.ok(dbSpans.some((s) => s.name === 'User.findOne'), 'User.findOne span must exist')
    assert.ok(dbSpans.some((s) => s.name === 'User.save'), 'User.save span must exist')
    assert.ok(dbSpans.some((s) => s.name === 'OrgMember.findOne'), 'OrgMember.findOne span must exist')
    assert.ok(dbSpans.some((s) => s.name === 'MembershipAccess.findOne'), 'MembershipAccess.findOne span must exist')
    assert.ok(dbSpans.some((s) => s.name === 'RolePermission.find'), 'RolePermission.find span must exist')
    assert.ok(dbSpans.some((s) => s.name === 'TrustedDevice.findOne'), 'TrustedDevice.findOne span must exist')
    assert.ok(dbSpans.some((s) => s.name === 'Session.findOne'), 'Session.findOne span must exist')
    assert.ok(dbSpans.some((s) => s.name === 'Session.create'), 'Session.create span must exist')
    assert.ok(dbSpans.some((s) => s.name === 'Session.save'), 'Session.save span must exist')
    assert.ok(dbSpans.some((s) => s.name === 'Org.find'), 'Org.find span must exist')
    assert.ok(dbSpans.some((s) => s.name === 'LoginHistory.create'), 'LoginHistory.create span must exist')

    // Verify individual Prisma spans
    assert.ok(dbSpans.some((s) => s.name === 'prisma:AdminSecurityPolicy.findUnique'), 'prisma:AdminSecurityPolicy.findUnique must exist')
    assert.ok(dbSpans.some((s) => s.name === 'prisma:SsoConnection.count'), 'prisma:SsoConnection.count must exist')

    // Verify NO duplicate spans for Session.create
    const sessionCreateSpans = dbSpans.filter((s) => s.name === 'Session.create')
    assert.equal(sessionCreateSpans.length, 1, 'Exactly one span for Session.create (nested save suppressed)')
  })

  it('captures database error status and exceptions without breaking execution', async () => {
    const mockMongoose = {
      Query: class MockQuery {
        op = 'findOne'
        model = { modelName: 'User', collection: { name: 'users' }, db: { name: 'cubicle_db' } }
        async exec() {
          throw new Error('MongoServerSelectionError: connection timed out')
        }
      },
      Model: class MockModel {
        async save() {}
      },
      Aggregate: class MockAggregate {
        async exec() {}
      },
    }
    ;(mongooseInstrumentation as any)._patchMongoose(mockMongoose)

    const httpTracer = trace.getTracer('pulse-express-test')
    await httpTracer.startActiveSpan('request handler - /api/auth/signin', async (handlerSpan) => {
      const q = new mockMongoose.Query()
      await assert.rejects(async () => {
        await q.exec()
      }, /MongoServerSelectionError/)

      handlerSpan.end()
    })

    const errorSpans = memoryExporter.getFinishedSpans().filter((s) => s.name === 'User.findOne')
    assert.equal(errorSpans.length, 1)
    const errSpan = errorSpans[0]
    assert.ok(errSpan)
    assert.equal(errSpan.status.code, SpanStatusCode.ERROR)
    assert.ok(errSpan.status.message?.includes('MongoServerSelectionError'))
  })
})
