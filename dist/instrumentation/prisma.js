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
import { trace, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { PrismaInstrumentation as OTelPrismaInstrumentation } from '@prisma/instrumentation';
const PRISMA_EXT_APPLIED = Symbol.for('pulse-sdk.prisma.extension.applied');
/**
 * Creates an OpenTelemetry query extension for Prisma Client.
 * Attach with `prismaClient.$extends(pulsePrismaExtension())`
 * or use automatic instrumentation.
 */
export function pulsePrismaExtension() {
    return {
        name: 'pulse-apm-prisma',
        query: {
            $allModels: {
                async $allOperations({ model, operation, args, query }) {
                    const tracer = trace.getTracer('@pulse-apm/prisma');
                    const spanName = `prisma:${model}.${operation}`;
                    return tracer.startActiveSpan(spanName, {
                        kind: SpanKind.CLIENT,
                        attributes: {
                            'db.system': 'postgresql',
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
    if (!prismaInstance || prismaInstance[PRISMA_EXT_APPLIED])
        return;
    if (typeof prismaInstance.$use === 'function') {
        ;
        prismaInstance[PRISMA_EXT_APPLIED] = true;
        prismaInstance.$use(async (params, next) => {
            const tracer = trace.getTracer('@pulse-apm/prisma');
            const spanName = `prisma:${params.model || 'raw'}.${params.action}`;
            return tracer.startActiveSpan(spanName, {
                kind: SpanKind.CLIENT,
                attributes: {
                    'db.system': 'postgresql',
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
    return new OTelPrismaInstrumentation({
        ...(captureQueries ? {} : { ignoreSpanTypes: [/^prisma:engine:/] }),
    });
}
export { OTelPrismaInstrumentation };
export default createPrismaInstrumentation;
