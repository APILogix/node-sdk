import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { SpanKind, trace } from '@opentelemetry/api'
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node'
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { createPrismaInstrumentation, instrumentPrismaClientInstance } from '../../src/instrumentation/prisma.js'

describe('Prisma auto-instrumentation fallback', () => {
  let memoryExporter: InMemorySpanExporter
  let provider: NodeTracerProvider

  beforeEach(() => {
    memoryExporter = new InMemorySpanExporter()
    provider = new NodeTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(memoryExporter)],
    })
    provider.register()
  })

  afterEach(() => {
    trace.disable()
  })

  it('installs $use middleware spans on an existing Prisma client instance', async () => {
    let middleware: any
    const prisma = {
      $use(fn: any) {
        middleware = fn
      },
    }

    assert.strictEqual(instrumentPrismaClientInstance(prisma), prisma)
    assert.equal(typeof middleware, 'function')

    const result = await middleware(
      { model: 'AdminSecurityPolicy', action: 'findUnique' },
      async () => ({ id: 'policy_1' })
    )
    assert.equal(result.id, 'policy_1')

    const span = memoryExporter.getFinishedSpans().find((s) => s.name === 'prisma:AdminSecurityPolicy.findUnique')
    assert.ok(span)
    assert.equal(span.kind, SpanKind.CLIENT)
    assert.equal(span.attributes['db.system'], 'postgresql')
    assert.equal(span.attributes['db.operation'], 'findUnique')
    assert.equal(span.attributes['db.sql.table'], 'AdminSecurityPolicy')
  })

  it('uses $extends when Prisma client versions do not expose $use', async () => {
    let extension: any
    const prisma = {
      $extends(ext: any) {
        extension = ext
        return { extended: true }
      },
    }

    const extended = instrumentPrismaClientInstance(prisma)
    assert.equal(extended.extended, true)
    assert.equal(extension.name, 'pulse-apm-prisma')

    const op = extension.query.$allModels.$allOperations
    const result = await op({
      model: 'SsoConnection',
      operation: 'count',
      args: { where: { status: 'active' } },
      query: async () => 2,
    })
    assert.equal(result, 2)

    const span = memoryExporter.getFinishedSpans().find((s) => s.name === 'prisma:SsoConnection.count')
    assert.ok(span)
    assert.equal(span.attributes['db.system'], 'postgresql')
    assert.equal(span.attributes['db.operation'], 'count')
  })

  it('patches PrismaClient construction so app code does not need manual instrumentation', async () => {
    class OriginalPrismaClient {
      static staticValue = 'preserved'
      middleware: any
      $use(fn: any) {
        this.middleware = fn
      }
    }

    const moduleExports = { PrismaClient: OriginalPrismaClient }
    const instrumentation = createPrismaInstrumentation({ enabled: true, captureQueries: true, captureParams: false })
    assert.ok(instrumentation)
    instrumentation.setTracerProvider(provider)
    instrumentation.enable()

    const definition = (instrumentation as any).init()[0]
    definition.patch(moduleExports, '7.9.1')

    assert.notStrictEqual(moduleExports.PrismaClient, OriginalPrismaClient)
    assert.equal((moduleExports.PrismaClient as any).staticValue, 'preserved')

    const prisma = new moduleExports.PrismaClient()
    assert.equal(typeof prisma.middleware, 'function')

    const result = await prisma.middleware(
      { model: 'AdminSecurityPolicy', action: 'findUnique' },
      async () => ({ id: 'policy_2' })
    )
    assert.equal(result.id, 'policy_2')

    const span = memoryExporter.getFinishedSpans().find((s) => s.name === 'prisma:AdminSecurityPolicy.findUnique')
    assert.ok(span)
    assert.equal(span.attributes['db.system'], 'postgresql')

    definition.unpatch(moduleExports, '7.9.1')
    assert.strictEqual(moduleExports.PrismaClient, OriginalPrismaClient)
  })
})
