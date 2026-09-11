import { describe, it, before, after, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { trace, SpanKind, SpanStatusCode } from '@opentelemetry/api'
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node'
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { MongooseInstrumentation } from '../../src/instrumentation/mongoose.js'
import { registerBootstrapAutoInstrumentations, registerAutoInstrumentations, resetAutoInstrumentations } from '../../src/instrumentation/auto-instrument.js'
import { ConfigManager } from '../../src/core/config-manager.js'
import { TEST_REMOTE_CONFIG } from '../fixtures/remote-config.js'

describe('Mongoose ODM Trace Instrumentation & In-Place Upgrades', () => {
  let memoryExporter: InMemorySpanExporter
  let provider: NodeTracerProvider

  beforeEach(() => {
    try {
      ConfigManager.getInstance().initialize({} as any, {
        ...TEST_REMOTE_CONFIG,
        features: { ...TEST_REMOTE_CONFIG.features, tracing: true },
        instrumentation: { ...TEST_REMOTE_CONFIG.instrumentation, mongodb: true },
      } as any)
    } catch {}

    memoryExporter = new InMemorySpanExporter()
    provider = new NodeTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(memoryExporter)],
    })
    provider.register()
  })

  afterEach(() => {
    resetAutoInstrumentations()
  })

  it('1. Emits MongoDB ODM child span with correct parentSpanId, traceId, and db attributes', async () => {
    const mockMongoose = {
      Query: class MockQuery {
        op = 'findOne'
        model = { modelName: 'User', collection: { name: 'users' }, db: { name: 'prod_db' } }
        _conditions = { email: 'user@example.com' }
        getFilter() { return this._conditions }
        async exec() {
          return { id: 'usr_123', email: 'user@example.com' }
        }
      },
      Model: class MockModel {
        isNew = false
        collection = { name: 'users' }
        db = { name: 'prod_db' }
        constructor() {
          ;(this as any).constructor.modelName = 'User'
        }
        async save() {
          return this
        }
      },
      Aggregate: class MockAggregate {
        model() {
          return { modelName: 'User', collection: { name: 'users' }, db: { name: 'prod_db' } }
        }
        async exec() {
          return [{ count: 1 }]
        }
      },
    }

    const instrumentation = new MongooseInstrumentation({ enabled: true }, TEST_REMOTE_CONFIG.privacy.capture)
    instrumentation.setTracerProvider(provider)
    instrumentation.enable()
    ;(instrumentation as any)._patchMongoose(mockMongoose)

    const tracer = trace.getTracer('test-http')
    await tracer.startActiveSpan('request handler - /api/auth/signin', async (httpSpan) => {
      const httpCtx = httpSpan.spanContext()

      // Execute Mongoose Query
      const query = new mockMongoose.Query()
      const queryResult = await query.exec()
      assert.equal(queryResult.id, 'usr_123')

      // Execute Mongoose Save
      const doc = new mockMongoose.Model()
      await doc.save()

      // Execute Mongoose Aggregate
      const agg = new mockMongoose.Aggregate()
      await agg.exec()

      httpSpan.end()

      const spans = memoryExporter.getFinishedSpans()
      assert.equal(spans.length, 4, 'Should have 1 HTTP span and 3 Mongoose spans')

      const querySpan = spans.find((s) => s.name === 'User.findOne')
      assert.ok(querySpan, 'Should record User.findOne span')
      assert.equal(querySpan.spanContext().traceId, httpCtx.traceId, 'Trace ID must match HTTP parent')
      assert.equal((querySpan as any).parentSpanContext?.spanId, httpCtx.spanId, 'Parent span ID must be the HTTP handler')
      assert.equal(querySpan.kind, SpanKind.CLIENT)
      assert.equal(querySpan.attributes['db.system'], 'mongodb')
      assert.equal(querySpan.attributes['db.mongodb.collection'], 'users')
      assert.equal(querySpan.attributes['db.name'], 'prod_db')
      assert.equal(querySpan.attributes['db.operation'], 'findOne')

      const saveSpan = spans.find((s) => s.name === 'User.save')
      assert.ok(saveSpan, 'Should record User.save span')
      assert.equal(saveSpan.spanContext().traceId, httpCtx.traceId)
      assert.equal((saveSpan as any).parentSpanContext?.spanId, httpCtx.spanId)
      assert.equal(saveSpan.attributes['db.system'], 'mongodb')

      const aggSpan = spans.find((s) => s.name === 'User.aggregate')
      assert.ok(aggSpan, 'Should record User.aggregate span')
      assert.equal(aggSpan.spanContext().traceId, httpCtx.traceId)
      assert.equal((aggSpan as any).parentSpanContext?.spanId, httpCtx.spanId)

      instrumentation.disable()
    })
  })

  it('2. Records exception and error status on query failure', async () => {
    const mockMongoose = {
      Query: class MockQuery {
        op = 'find'
        model = { modelName: 'OrgMember', collection: { name: 'orgmembers' }, db: { name: 'prod_db' } }
        async exec() {
          throw new Error('MongoNetworkTimeoutException')
        }
      },
      Model: class MockModel {
        async save() {}
      },
      Aggregate: class MockAggregate {
        async exec() {}
      },
    }

    const instrumentation = new MongooseInstrumentation({ enabled: true })
    instrumentation.setTracerProvider(provider)
    instrumentation.enable()
    ;(instrumentation as any)._patchMongoose(mockMongoose)

    const query = new mockMongoose.Query()
    await assert.rejects(async () => {
      await query.exec()
    }, /MongoNetworkTimeoutException/)

    const spans = memoryExporter.getFinishedSpans()
    assert.equal(spans.length, 1)
    const span = spans[0]
    assert.ok(span)
    assert.equal(span.name, 'OrgMember.find')
    assert.equal(span.status.code, SpanStatusCode.ERROR)
    assert.match(span.status.message || '', /MongoNetworkTimeoutException/)
    assert.equal(span.events.length, 1)
    assert.equal(span.events[0]?.name, 'exception')

    instrumentation.disable()
  })

  it('3. In-place upgrade preserves bootstrap monkey patches without unwrapping', () => {
    const mockMongoose = {
      Query: class MockQuery {
        op = 'findOne'
        async exec() { return { ok: true } }
      },
      Model: class MockModel {
        async save() { return this }
      },
    }

    // Attach mock to globalThis so bootstrap detects it
    ;(globalThis as any).mongoose = mockMongoose

    registerBootstrapAutoInstrumentations()

    // Query.prototype.exec must now be patched
    const patchedExec1 = mockMongoose.Query.prototype.exec
    assert.notEqual(patchedExec1.name, 'exec')
    assert.equal(patchedExec1.name, 'pulsePatchedQueryExec')

    // Now simulate runtime init() calling registerAutoInstrumentations()
    registerAutoInstrumentations()

    // The monkey patch MUST NOT be unwrapped!
    const patchedExec2 = mockMongoose.Query.prototype.exec
    assert.equal(patchedExec2.name, 'pulsePatchedQueryExec', 'Must remain patched after registerAutoInstrumentations()')
    assert.strictEqual(patchedExec1, patchedExec2, 'Must be the exact same wrapper reference (no unwrap + rewrap churn)')

    delete (globalThis as any).mongoose
  })
})
