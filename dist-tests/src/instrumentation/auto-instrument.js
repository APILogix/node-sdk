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
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { FastifyInstrumentation } from '@opentelemetry/instrumentation-fastify';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { GraphQLInstrumentation } from '@opentelemetry/instrumentation-graphql';
import { MongoDBInstrumentation } from '@opentelemetry/instrumentation-mongodb';
import { RedisInstrumentation } from '@opentelemetry/instrumentation-redis-4';
import { PrismaInstrumentation } from '@prisma/instrumentation';
import { BullMQInstrumentation } from 'opentelemetry-instrumentation-bullmq';
import { client } from '../core/client.js';
import { getLogger } from '../utils/logger.js';
import { ConfigManager } from '../core/config-manager.js';
import { createAxiosInstrumentation } from './axios.js';
const INSTRUMENTATION_GUARD = Symbol.for('pulse-sdk.auto-instrumentation.registered');
function resolveInstrumentationOptions(userOptions) {
    const configManager = ConfigManager.getInstance();
    const config = configManager.getConfig();
    const instr = config.instrumentation;
    const tracing = config.tracing;
    const httpEnabled = instr.http ?? userOptions.http ?? true;
    const httpsEnabled = instr.https ?? true;
    const expressEnabled = typeof instr.express === 'object'
        ? instr.express.enabled
        : (instr.express ?? userOptions.express ?? true);
    const fastifyConfig = typeof instr.fastify === 'object'
        ? instr.fastify
        : { enabled: instr.fastify ?? userOptions.fastify ?? true, captureHooks: true, captureValidationErrors: true };
    const fetchEnabled = instr.fetch ?? userOptions.undici ?? true;
    const graphqlEnabled = typeof instr.graphql === 'object'
        ? instr.graphql.enabled
        : (instr.graphql ?? userOptions.graphql ?? false);
    const graphqlConfig = typeof instr.graphql === 'object'
        ? { enabled: graphqlEnabled, captureResolvers: instr.graphql.captureResolvers ?? true }
        : { enabled: graphqlEnabled, captureResolvers: true };
    const prismaEnabled = typeof instr.prisma === 'object'
        ? instr.prisma.enabled
        : (instr.prisma ?? userOptions.prisma ?? false);
    const prismaConfig = typeof instr.prisma === 'object'
        ? { enabled: prismaEnabled, captureQueries: instr.prisma.captureQueries ?? true, captureParams: instr.prisma.captureParams ?? false }
        : { enabled: prismaEnabled, captureQueries: true, captureParams: false };
    const mongodbEnabled = instr.mongodb ?? userOptions.mongodb ?? false;
    const redisEnabled = instr.redis ?? userOptions.redis ?? false;
    const bullmqEnabled = instr.bullmq ?? userOptions.bullmq ?? false;
    const axiosEnabled = instr.axios ?? userOptions.axios ?? false;
    return {
        http: httpEnabled && httpsEnabled,
        https: httpsEnabled,
        express: expressEnabled,
        fastify: fastifyConfig.enabled,
        undici: fetchEnabled,
        graphql: graphqlConfig.enabled,
        graphqlConfig,
        prisma: prismaConfig.enabled,
        prismaConfig,
        mongodb: mongodbEnabled,
        redis: redisEnabled,
        bullmq: bullmqEnabled,
        axios: axiosEnabled,
        fastifyConfig: {
            captureHooks: fastifyConfig.captureHooks ?? true,
            captureValidationErrors: fastifyConfig.captureValidationErrors ?? true,
        },
        ignoredRoutes: [...(tracing.ignoredRoutes ?? [])],
        ignoredMethods: [...(tracing.ignoredMethods ?? [])],
        captureConfig: tracing.capture ?? { headers: false, body: false, response: false, query: true, cookies: false },
    };
}
export function registerAutoInstrumentations(options = {}) {
    const g = globalThis;
    if (g[INSTRUMENTATION_GUARD])
        return;
    g[INSTRUMENTATION_GUARD] = true;
    const logger = getLogger();
    const resolved = resolveInstrumentationOptions(options);
    const instrumentations = [];
    const axiosCleanup = [];
    if (resolved.http) {
        instrumentations.push(new HttpInstrumentation({
            ignoreOutgoingRequestHook: (request) => {
                if (!client.initialized)
                    return false;
                try {
                    const ingestUrl = client.config.ingestUrl;
                    if (!ingestUrl)
                        return false;
                    let url = '';
                    if (typeof request === 'string') {
                        url = request;
                    }
                    else if (request && typeof request === 'object') {
                        const req = request;
                        url = String(req.href ?? req.url ?? '');
                    }
                    if (!url)
                        return false;
                    const target = new URL(url);
                    const ingest = new URL(ingestUrl);
                    return isInternalSdkUrl(target, ingest);
                }
                catch {
                    return false;
                }
            },
            ignoreIncomingRequestHook: (request) => {
                try {
                    const req = request;
                    const url = String(req.url ?? '');
                    const path = url.split('?')[0] ?? '';
                    if (resolved.ignoredRoutes.some(r => path === r || path.startsWith(r))) {
                        return true;
                    }
                    const method = String(req.method ?? '').toUpperCase();
                    if (resolved.ignoredMethods.includes(method)) {
                        return true;
                    }
                    return ['/v1/events', '/v1/init', '/v1/sdk-config'].includes(path);
                }
                catch {
                    return false;
                }
            },
        }));
    }
    if (resolved.express) {
        instrumentations.push(new ExpressInstrumentation());
    }
    if (resolved.fastify) {
        instrumentations.push(new FastifyInstrumentation());
    }
    if (resolved.undici) {
        instrumentations.push(new UndiciInstrumentation({
            ignoreRequestHook: (request) => {
                if (!client.initialized)
                    return false;
                try {
                    const ingest = new URL(client.config.ingestUrl);
                    const req = request;
                    const rawOrigin = req.origin ?? req['origin'];
                    const rawPath = req.path ?? req['path'] ?? req.pathname;
                    const url = rawOrigin
                        ? new URL(String(rawPath ?? '/'), String(rawOrigin))
                        : new URL(String(req.url ?? ''));
                    return isInternalSdkUrl(url, ingest);
                }
                catch {
                    return false;
                }
            },
        }));
    }
    if (resolved.graphql) {
        instrumentations.push(new GraphQLInstrumentation({
            enabled: true,
            ignoreResolveSpans: !resolved.graphqlConfig.captureResolvers,
        }));
    }
    if (resolved.prisma) {
        instrumentations.push(new PrismaInstrumentation({
            enabled: true,
        }));
    }
    if (resolved.mongodb) {
        instrumentations.push(new MongoDBInstrumentation({
            enabled: true,
            enhancedDatabaseReporting: resolved.captureConfig.body,
        }));
    }
    if (resolved.redis) {
        instrumentations.push(new RedisInstrumentation({
            enabled: true,
            dbStatementSerializer: (cmdName, cmdArgs) => {
                const sensitiveCommands = ['AUTH', 'CONFIG SET', 'CONFIG GET', 'DEL', 'EXPIRE', 'EXPIREAT', 'GET', 'SET', 'HSET', 'HGET', 'HGETALL'];
                if (sensitiveCommands.includes(cmdName.toUpperCase())) {
                    return `${cmdName} [REDACTED]`;
                }
                if (!resolved.captureConfig.body) {
                    return cmdName;
                }
                return `${cmdName} ${cmdArgs.join(' ')}`;
            },
        }));
    }
    if (resolved.bullmq) {
        instrumentations.push(new BullMQInstrumentation({
            enabled: true,
        }));
    }
    if (resolved.axios) {
        const axiosInstrumentation = createAxiosInstrumentation(true, {
            captureRequestData: resolved.captureConfig.body,
            captureResponseData: resolved.captureConfig.response,
        }, resolved.captureConfig);
        if (axiosInstrumentation) {
            axiosCleanup.push(axiosInstrumentation.teardown);
            axiosInstrumentation.setup();
        }
    }
    const registeredInstrumentations = instrumentations.filter(Boolean);
    if (registeredInstrumentations.length > 0) {
        registerInstrumentations({
            instrumentations: registeredInstrumentations,
        });
    }
    logger.info('Auto-instrumentations registered (remote-config-driven)', {
        http: resolved.http,
        https: resolved.https,
        express: resolved.express,
        fastify: resolved.fastify,
        undici: resolved.undici,
        graphql: resolved.graphql,
        prisma: resolved.prisma,
        mongodb: resolved.mongodb,
        redis: resolved.redis,
        bullmq: resolved.bullmq,
        axios: resolved.axios,
        fastifyCaptureHooks: resolved.fastifyConfig.captureHooks,
        fastifyCaptureValidationErrors: resolved.fastifyConfig.captureValidationErrors,
        graphqlCaptureResolvers: resolved.graphqlConfig.captureResolvers,
        prismaCaptureQueries: resolved.prismaConfig.captureQueries,
        prismaCaptureParams: resolved.prismaConfig.captureParams,
        ignoredRoutes: resolved.ignoredRoutes,
        ignoredMethods: resolved.ignoredMethods,
        count: registeredInstrumentations.length,
    });
}
export function resetAutoInstrumentations() {
    delete globalThis[INSTRUMENTATION_GUARD];
}
function isInternalSdkUrl(target, ingest) {
    if (target.origin !== ingest.origin)
        return false;
    return target.pathname === ingest.pathname
        || target.pathname === '/v1/events'
        || target.pathname === '/v1/init'
        || target.pathname === '/v1/sdk-config';
}
export { GraphQLInstrumentation, MongoDBInstrumentation, RedisInstrumentation, PrismaInstrumentation, BullMQInstrumentation };
