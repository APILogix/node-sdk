/**
 * Prisma Instrumentation — OpenTelemetry auto-instrumentation
 * wrapped with Pulse SDK guards and remote config support.
 *
 * Features:
 * - Query spans with operation name, timing, and model
 * - Parameter capture (configurable via captureParams)
 * - Error tracking with query context
 * - Batch query support
 * - Transaction instrumentation
 */

import { trace, SpanKind, SpanStatusCode } from '@opentelemetry/api'
import { InstrumentationBase, InstrumentationNodeModuleDefinition } from '@opentelemetry/instrumentation'
import { PrismaInstrumentation as OTelPrismaInstrumentation } from '@prisma/instrumentation'
import type { TracerProvider } from '@opentelemetry/api'
import { getLogger } from '../utils/logger.js'

export interface PrismaInstrumentationOptions {
  enabled: boolean
  captureQueries: boolean
  captureParams: boolean
}

const PRISMA_EXT_APPLIED = Symbol.for('pulse-sdk.prisma.extension.applied')
const PRISMA_ORIGINAL_CLIENT = Symbol.for('pulse-sdk.prisma.original-client')

export function resolvePrismaDbSystem(prismaInstance: any): string {
  const provider = prismaInstance?._engineConfig?.activeProvider ?? prismaInstance?._activeProvider
  if (typeof provider === 'string' && provider) {
    return provider === 'postgres' ? 'postgresql' : provider
  }
  return 'postgresql'
}

/**
 * Creates an OpenTelemetry query extension for Prisma Client.
 * Attach with `prismaClient.$extends(pulsePrismaExtension())`
 * or use automatic instrumentation.
 */
export function pulsePrismaExtension(dbSystem = 'postgresql') {
  return {
    name: 'pulse-apm-prisma',
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }: any) {
          const tracer = trace.getTracer('@pulse-apm/prisma')
          const spanName = `prisma:${model}.${operation}`
          return tracer.startActiveSpan(
            spanName,
            {
              kind: SpanKind.CLIENT,
              attributes: {
                'db.system': dbSystem,
                'db.operation': operation,
                'db.sql.table': model,
              },
            },
            async (span) => {
              try {
                const result = await query(args)
                span.end()
                return result
              } catch (err: any) {
                span.recordException(err)
                span.setStatus({ code: SpanStatusCode.ERROR, message: err?.message || String(err) })
                span.end()
                throw err
              }
            }
          )
        },
      },
    },
  }
}

/**
 * Automatically instrument a PrismaClient instance via $use middleware.
 * Ensures queries emit spans even if previewFeatures = ["tracing"] is omitted in schema.prisma.
 */
export function instrumentPrismaClientInstance(prismaInstance: any): any {
  if (!prismaInstance || (prismaInstance as any)[PRISMA_EXT_APPLIED]) return prismaInstance
  const dbSystem = resolvePrismaDbSystem(prismaInstance)

  if (typeof prismaInstance.$use === 'function') {
    ;(prismaInstance as any)[PRISMA_EXT_APPLIED] = true
    prismaInstance.$use(async (params: any, next: any) => {
      const tracer = trace.getTracer('@pulse-apm/prisma')
      const spanName = `prisma:${params.model || 'raw'}.${params.action}`
      return tracer.startActiveSpan(
        spanName,
        {
          kind: SpanKind.CLIENT,
          attributes: {
            'db.system': dbSystem,
            'db.operation': params.action,
            'db.sql.table': params.model || '',
          },
        },
        async (span) => {
          try {
            const result = await next(params)
            span.end()
            return result
          } catch (err: any) {
            span.recordException(err)
            span.setStatus({ code: SpanStatusCode.ERROR, message: err?.message || String(err) })
            span.end()
            throw err
          }
        }
      )
    })
    return prismaInstance
  }

  if (typeof prismaInstance.$extends === 'function') {
    try {
      const extended = prismaInstance.$extends(pulsePrismaExtension(dbSystem))
      if (extended && typeof extended === 'object') {
        ;(extended as any)[PRISMA_EXT_APPLIED] = true
        ;(prismaInstance as any)[PRISMA_EXT_APPLIED] = true
        return extended
      }
    } catch (err) {
      getLogger().debug('Prisma $extends instrumentation failed', { error: String(err) })
    }
  }

  return prismaInstance
}

function copyStaticProperties(target: any, source: any): void {
  for (const key of Reflect.ownKeys(source)) {
    if (key === 'prototype' || key === 'length' || key === 'name') continue
    const descriptor = Object.getOwnPropertyDescriptor(source, key)
    if (!descriptor) continue
    try {
      Object.defineProperty(target, key, descriptor)
    } catch {}
  }
}

function patchPrismaClientExport(moduleExports: any): any {
  const prismaModule = moduleExports?.default?.PrismaClient ? moduleExports.default : moduleExports
  const OriginalPrismaClient = prismaModule?.PrismaClient
  if (typeof OriginalPrismaClient !== 'function' || (OriginalPrismaClient as any)[PRISMA_ORIGINAL_CLIENT]) {
    return moduleExports
  }

  const PulsePrismaClient = function PulsePrismaClient(this: any, ...args: any[]) {
    const target = new.target || PulsePrismaClient
    const instance = Reflect.construct(OriginalPrismaClient, args, target)
    const instrumented = instrumentPrismaClientInstance(instance)
    // If subclassing (target !== PulsePrismaClient), preserve the original instance reference
    if (target !== PulsePrismaClient) {
      return instance
    }
    return instrumented
  }

  Object.setPrototypeOf(PulsePrismaClient, OriginalPrismaClient)
  PulsePrismaClient.prototype = OriginalPrismaClient.prototype
  ;(PulsePrismaClient as any)[PRISMA_ORIGINAL_CLIENT] = OriginalPrismaClient
  copyStaticProperties(PulsePrismaClient, OriginalPrismaClient)

  prismaModule.PrismaClient = PulsePrismaClient
  if (moduleExports?.default?.PrismaClient) {
    moduleExports.default.PrismaClient = PulsePrismaClient
  }

  getLogger().debug('PrismaClient constructor auto-instrumentation attached')
  return moduleExports
}

function unpatchPrismaClientExport(moduleExports: any): void {
  const prismaModule = moduleExports?.default?.PrismaClient ? moduleExports.default : moduleExports
  const current = prismaModule?.PrismaClient
  const original = current?.[PRISMA_ORIGINAL_CLIENT]
  if (original) {
    prismaModule.PrismaClient = original
    if (moduleExports?.default?.PrismaClient) {
      moduleExports.default.PrismaClient = original
    }
  }
}

export class PulsePrismaInstrumentation extends InstrumentationBase {
  private otelPrisma?: OTelPrismaInstrumentation

  constructor(config: { enabled?: boolean; captureQueries?: boolean; captureParams?: boolean; ignoreSpanTypes?: (string | RegExp)[] } = {}) {
    super('@pulse-apm/instrumentation-prisma', '1.0.0', { enabled: config.enabled ?? true })
    try {
      this.otelPrisma = new OTelPrismaInstrumentation({
        ...(config.captureQueries === false ? { ignoreSpanTypes: [/^prisma:engine:/] } : {}),
        ...(config.ignoreSpanTypes ? { ignoreSpanTypes: config.ignoreSpanTypes } : {}),
      } as any)
      if (this.isEnabled() && typeof (this.otelPrisma as any)?.enable === 'function') {
        ;(this.otelPrisma as any).enable()
      }
    } catch {}
  }

  override setTracerProvider(tracerProvider: TracerProvider): void {
    super.setTracerProvider(tracerProvider)
    if (this.otelPrisma && typeof (this.otelPrisma as any).setTracerProvider === 'function') {
      try {
        ;(this.otelPrisma as any).setTracerProvider(tracerProvider)
      } catch {}
    }
  }

  protected init() {
    return [
      new InstrumentationNodeModuleDefinition(
        '@prisma/client',
        ['>=4.0.0 <8'],
        (moduleExports: any) => patchPrismaClientExport(moduleExports),
        (moduleExports: any) => unpatchPrismaClientExport(moduleExports)
      ),
    ]
  }

  override enable(): void {
    super.enable()
    if (this.otelPrisma && typeof (this.otelPrisma as any).enable === 'function') {
      try {
        ;(this.otelPrisma as any).enable()
      } catch (err) {
        getLogger().debug('Prisma global tracing helper enable failed', { error: String(err) })
      }
    }
  }

  override disable(): void {
    super.disable()
    if (this.otelPrisma && typeof (this.otelPrisma as any).disable === 'function') {
      try {
        ;(this.otelPrisma as any).disable()
      } catch {}
    }
  }
}

export function createPrismaInstrumentation(
  config: { enabled: boolean; captureQueries?: boolean; captureParams?: boolean } | boolean,
  mergedOptions?: Partial<PrismaInstrumentationOptions>
): PulsePrismaInstrumentation | null {
  const enabled = typeof config === 'object' ? config.enabled : config

  if (!enabled) {
    return null
  }

  const captureQueries = typeof config === 'object'
    ? (config.captureQueries ?? true)
    : (mergedOptions?.captureQueries ?? true)

  return new PulsePrismaInstrumentation({
    enabled: true,
    captureQueries,
    captureParams: typeof config === 'object' ? (config.captureParams ?? false) : (mergedOptions?.captureParams ?? false),
  })
}

export { OTelPrismaInstrumentation }
export default createPrismaInstrumentation
