/**
 * Prisma Instrumentation — OpenTelemetry auto-instrumentation
 * wrapped with LynkTrace SDK guards and remote config support.
 *
 * Features:
 * - Query spans with operation name, timing, and model
 * - Parameter capture (configurable via captureParams)
 * - Error tracking with query context
 * - Batch query support
 * - Transaction instrumentation
 */
import { trace, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { InstrumentationBase, InstrumentationNodeModuleDefinition } from '@opentelemetry/instrumentation';
import { PrismaInstrumentation as OTelPrismaInstrumentation } from '@prisma/instrumentation';
import { getLogger } from '../utils/logger.js';
const PRISMA_EXT_APPLIED = Symbol.for('lynktrace.prisma.extension.applied');
const PRISMA_EXT_APPLIED_LEGACY = Symbol.for('pulse-sdk.prisma.extension.applied');
const PRISMA_ORIGINAL_CLIENT = Symbol.for('lynktrace.prisma.original-client');
const PRISMA_ORIGINAL_CLIENT_LEGACY = Symbol.for('pulse-sdk.prisma.original-client');
export function resolvePrismaDbSystem(prismaInstance) {
    const provider = prismaInstance?._engineConfig?.activeProvider ?? prismaInstance?._activeProvider;
    if (typeof provider === 'string' && provider) {
        return provider === 'postgres' ? 'postgresql' : provider;
    }
    return 'postgresql';
}
/**
 * Creates an OpenTelemetry query extension for Prisma Client.
 * Attach with `prismaClient.$extends(lynktracePrismaExtension())`
 * or use automatic instrumentation.
 */
export function lynktracePrismaExtension(dbSystem = 'postgresql') {
    return {
        name: 'lynktrace-prisma',
        query: {
            $allModels: {
                async $allOperations({ model, operation, args, query }) {
                    const tracer = trace.getTracer('@lynktrace/prisma');
                    const spanName = `prisma:${model}.${operation}`;
                    return tracer.startActiveSpan(spanName, {
                        kind: SpanKind.CLIENT,
                        attributes: {
                            'db.system': dbSystem,
                            'db.operation': operation,
                            'db.sql.table': model,
                        },
                    }, async (span) => {
                        try {
                            const result = await query(args);
                            span.end();
                            return result;
                        }
                        catch (err) {
                            span.recordException(err);
                            span.setStatus({ code: SpanStatusCode.ERROR, message: err?.message || String(err) });
                            span.end();
                            throw err;
                        }
                    });
                },
            },
        },
    };
}
/**
 * Automatically instrument a PrismaClient instance via $use middleware.
 * Ensures queries emit spans even if previewFeatures = ["tracing"] is omitted in schema.prisma.
 */
export function instrumentPrismaClientInstance(prismaInstance) {
    if (!prismaInstance || prismaInstance[PRISMA_EXT_APPLIED] || prismaInstance[PRISMA_EXT_APPLIED_LEGACY])
        return prismaInstance;
    const dbSystem = resolvePrismaDbSystem(prismaInstance);
    if (typeof prismaInstance.$use === 'function') {
        ;
        prismaInstance[PRISMA_EXT_APPLIED] = true;
        prismaInstance[PRISMA_EXT_APPLIED_LEGACY] = true;
        prismaInstance.$use(async (params, next) => {
            const tracer = trace.getTracer('@lynktrace/prisma');
            const spanName = `prisma:${params.model || 'raw'}.${params.action}`;
            return tracer.startActiveSpan(spanName, {
                kind: SpanKind.CLIENT,
                attributes: {
                    'db.system': dbSystem,
                    'db.operation': params.action,
                    'db.sql.table': params.model || '',
                },
            }, async (span) => {
                try {
                    const result = await next(params);
                    span.end();
                    return result;
                }
                catch (err) {
                    span.recordException(err);
                    span.setStatus({ code: SpanStatusCode.ERROR, message: err?.message || String(err) });
                    span.end();
                    throw err;
                }
            });
        });
        return prismaInstance;
    }
    if (typeof prismaInstance.$extends === 'function') {
        try {
            const extended = prismaInstance.$extends(lynktracePrismaExtension(dbSystem));
            if (extended && typeof extended === 'object') {
                ;
                extended[PRISMA_EXT_APPLIED] = true;
                extended[PRISMA_EXT_APPLIED_LEGACY] = true;
                prismaInstance[PRISMA_EXT_APPLIED] = true;
                prismaInstance[PRISMA_EXT_APPLIED_LEGACY] = true;
                return extended;
            }
        }
        catch (err) {
            getLogger().debug('Prisma $extends instrumentation failed', { error: String(err) });
        }
    }
    return prismaInstance;
}
function copyStaticProperties(target, source) {
    for (const key of Reflect.ownKeys(source)) {
        if (key === 'prototype' || key === 'length' || key === 'name')
            continue;
        const descriptor = Object.getOwnPropertyDescriptor(source, key);
        if (!descriptor)
            continue;
        try {
            Object.defineProperty(target, key, descriptor);
        }
        catch { }
    }
}
function patchPrismaClientExport(moduleExports) {
    const prismaModule = moduleExports?.default?.PrismaClient ? moduleExports.default : moduleExports;
    const OriginalPrismaClient = prismaModule?.PrismaClient;
    if (typeof OriginalPrismaClient !== 'function' ||
        OriginalPrismaClient[PRISMA_ORIGINAL_CLIENT] ||
        OriginalPrismaClient[PRISMA_ORIGINAL_CLIENT_LEGACY]) {
        return moduleExports;
    }
    const LynkTracePrismaClient = function LynkTracePrismaClient(...args) {
        const target = new.target || LynkTracePrismaClient;
        const instance = Reflect.construct(OriginalPrismaClient, args, target);
        const instrumented = instrumentPrismaClientInstance(instance);
        // If subclassing (target !== LynkTracePrismaClient), preserve the original instance reference
        if (target !== LynkTracePrismaClient) {
            return instance;
        }
        return instrumented;
    };
    Object.setPrototypeOf(LynkTracePrismaClient, OriginalPrismaClient);
    LynkTracePrismaClient.prototype = OriginalPrismaClient.prototype;
    LynkTracePrismaClient[PRISMA_ORIGINAL_CLIENT] = OriginalPrismaClient;
    LynkTracePrismaClient[PRISMA_ORIGINAL_CLIENT_LEGACY] = OriginalPrismaClient;
    copyStaticProperties(LynkTracePrismaClient, OriginalPrismaClient);
    prismaModule.PrismaClient = LynkTracePrismaClient;
    if (moduleExports?.default?.PrismaClient) {
        moduleExports.default.PrismaClient = LynkTracePrismaClient;
    }
    getLogger().debug('PrismaClient constructor auto-instrumentation attached');
    return moduleExports;
}
function unpatchPrismaClientExport(moduleExports) {
    const prismaModule = moduleExports?.default?.PrismaClient ? moduleExports.default : moduleExports;
    const current = prismaModule?.PrismaClient;
    const original = current?.[PRISMA_ORIGINAL_CLIENT] ?? current?.[PRISMA_ORIGINAL_CLIENT_LEGACY];
    if (original) {
        prismaModule.PrismaClient = original;
        if (moduleExports?.default?.PrismaClient) {
            moduleExports.default.PrismaClient = original;
        }
    }
}
export class LynkTracePrismaInstrumentation extends InstrumentationBase {
    otelPrisma;
    constructor(config = {}) {
        super('@lynktrace/instrumentation-prisma', '1.0.0', { enabled: config.enabled ?? true });
        try {
            this.otelPrisma = new OTelPrismaInstrumentation({
                ...(config.captureQueries === false ? { ignoreSpanTypes: [/^prisma:engine:/] } : {}),
                ...(config.ignoreSpanTypes ? { ignoreSpanTypes: config.ignoreSpanTypes } : {}),
            });
            if (this.isEnabled() && typeof this.otelPrisma?.enable === 'function') {
                ;
                this.otelPrisma.enable();
            }
        }
        catch { }
    }
    setTracerProvider(tracerProvider) {
        super.setTracerProvider(tracerProvider);
        if (this.otelPrisma && typeof this.otelPrisma.setTracerProvider === 'function') {
            try {
                ;
                this.otelPrisma.setTracerProvider(tracerProvider);
            }
            catch { }
        }
    }
    init() {
        return [
            new InstrumentationNodeModuleDefinition('@prisma/client', ['>=4.0.0 <8'], (moduleExports) => patchPrismaClientExport(moduleExports), (moduleExports) => unpatchPrismaClientExport(moduleExports)),
        ];
    }
    enable() {
        super.enable();
        if (this.otelPrisma && typeof this.otelPrisma.enable === 'function') {
            try {
                ;
                this.otelPrisma.enable();
            }
            catch (err) {
                getLogger().debug('Prisma global tracing helper enable failed', { error: String(err) });
            }
        }
    }
    disable() {
        super.disable();
        if (this.otelPrisma && typeof this.otelPrisma.disable === 'function') {
            try {
                ;
                this.otelPrisma.disable();
            }
            catch { }
        }
    }
}
export function createPrismaInstrumentation(config, mergedOptions) {
    const enabled = typeof config === 'object' ? config.enabled : config;
    if (!enabled) {
        return null;
    }
    const captureQueries = typeof config === 'object'
        ? (config.captureQueries ?? true)
        : (mergedOptions?.captureQueries ?? true);
    return new LynkTracePrismaInstrumentation({
        enabled: true,
        captureQueries,
        captureParams: typeof config === 'object' ? (config.captureParams ?? false) : (mergedOptions?.captureParams ?? false),
    });
}
export { OTelPrismaInstrumentation };
export default createPrismaInstrumentation;
