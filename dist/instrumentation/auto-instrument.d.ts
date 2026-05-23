/**
 * Auto Instrumentation — selective OpenTelemetry instrumentations
 * wrapped with Pulse SDK guards, now driven by remote config.
 *
 * Reads from ConfigManager.getConfig().instrumentation to decide
 * which modules to patch. Never monkey-patches a module if its
 * remote config flag is false.
 *
 * Provides:
 * - HTTP client instrumentation (http/https/fetch/undici)
 * - Express framework instrumentation
 * - Fastify framework instrumentation (with captureHooks / captureValidationErrors)
 * - GraphQL instrumentation (with captureResolvers)
 * - Prisma instrumentation (with captureQueries / captureParams)
 * - MongoDB instrumentation
 * - Redis instrumentation
 * - BullMQ instrumentation
 * - Axios HTTP client instrumentation
 * - Self-request guard (prevents tracing SDK's own ingestion calls)
 * - No duplicate spans (OTel SDK handles deduplication)
 * - Low-overhead runtime performance
 *
 * Architecture:
 *   OTel Instrumentation → Pulse SpanProcessor → PipelineSpanExporter → EventPipeline
 */
import { GraphQLInstrumentation } from '@opentelemetry/instrumentation-graphql';
import { MongoDBInstrumentation } from '@opentelemetry/instrumentation-mongodb';
import { RedisInstrumentation } from '@opentelemetry/instrumentation-redis-4';
import { PrismaInstrumentation } from '@prisma/instrumentation';
import { BullMQInstrumentation } from 'opentelemetry-instrumentation-bullmq';
export interface AutoInstrumentOptions {
    http?: boolean;
    express?: boolean;
    fastify?: boolean;
    undici?: boolean;
    graphql?: boolean;
    prisma?: boolean;
    mongodb?: boolean;
    redis?: boolean;
    bullmq?: boolean;
    axios?: boolean;
}
export declare function registerAutoInstrumentations(options?: AutoInstrumentOptions): void;
export declare function resetAutoInstrumentations(): void;
export { GraphQLInstrumentation, MongoDBInstrumentation, RedisInstrumentation, PrismaInstrumentation, BullMQInstrumentation };
//# sourceMappingURL=auto-instrument.d.ts.map