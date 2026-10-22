/**
 * Auto Instrumentation — selective OpenTelemetry instrumentations
 * wrapped with Pulse SDK guards, driven by remote config.
 *
 * Reads from ConfigManager.getConfig().instrumentation to decide
 * which modules to patch. Never monkey-patches a module if its
 * remote config flag is false.
 *
 * Lifecycle guarantees:
 * - Idempotent registration via a global symbol guard (safe across multiple
 *   imports of the SDK in the same process — common in monorepos).
 * - Full reset on shutdown: the guard symbol is cleared AND every
 *   instrumentation that exposes a teardown is invoked. This ensures the
 *   next init() rebuilds instrumentation from scratch.
 *
 * Architecture:
 *   OTel Instrumentation → Pulse SpanProcessor → PipelineSpanExporter → EventPipeline
 */
import { context, SpanKind, trace } from '@opentelemetry/api';
import { getTraceAggregator } from '../tracing/trace-aggregator.js';
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { FastifyOtelInstrumentation } from '@fastify/otel';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { GraphQLInstrumentation } from '@opentelemetry/instrumentation-graphql';
import { MongoDBInstrumentation } from '@opentelemetry/instrumentation-mongodb';
import { RedisInstrumentation } from '@opentelemetry/instrumentation-redis';
import { PrismaInstrumentation } from '@prisma/instrumentation';
import { BullMQInstrumentation } from 'opentelemetry-instrumentation-bullmq';
import { client } from '../core/client.js';
import { getLogger } from '../utils/logger.js';
import { ConfigManager } from '../core/config-manager.js';
import { EntitlementGate } from '../core/entitlement-gate.js';
import { createAxiosInstrumentation, SUPPRESS_INNER_HTTP_LYNKTRACE, SUPPRESS_INNER_HTTP } from './axios.js';
import { createPgInstrumentation } from './pg.js';
import { createMySQLInstrumentation } from './mysql.js';
import { createMongoDBInstrumentation } from './mongodb.js';
import { createMongooseInstrumentation, MongooseInstrumentation } from './mongoose.js';
import { createRedisInstrumentation, createIORedisInstrumentation } from './redis.js';
import { createBullMQInstrumentation } from './bullmq.js';
import { createGraphQLInstrumentation } from './graphql.js';
import { createPrismaInstrumentation } from './prisma.js';
import { createNodemailerInstrumentation } from './nodemailer.js';
import { createDynamoDBInstrumentation } from './dynamodb.js';
import { createCassandraInstrumentation } from './cassandra.js';
import { createElasticsearchInstrumentation } from './elasticsearch.js';
import { createMSSQLInstrumentation } from './mssql.js';
import { createSQLiteInstrumentation } from './sqlite.js';
import { createTypeORMInstrumentation } from './typeorm.js';
import { createDrizzleInstrumentation } from './drizzle.js';
import { createMikroORMInstrumentation } from './mikro-orm.js';
import { createSequelizeInstrumentation } from './sequelize.js';
import { createKnexInstrumentation } from './knex.js';
import { createKafkaInstrumentation } from './kafka.js';
import { createAMQPInstrumentation } from './amqplib.js';
import { createSqsSnsInstrumentation } from './sqs-sns.js';
import { createPubSubInstrumentation } from './pubsub.js';
import { createGrpcInstrumentation } from './grpc.js';
import { createNestJSInstrumentation } from './nestjs.js';
import { createDNSInstrumentation } from './dns.js';
import { patchEventEmitter, unpatchEventEmitter } from './event-emitter-patch.js';
import { installHttpLifecycleGuard, uninstallHttpLifecycleGuard } from './http-lifecycle-guard.js';
import { registerEsmLoaderHooks } from './esm-loader.js';
// ─── Global Guard + Teardown Registry ───────────────────────────────────────
// We attach to globalThis (via Symbol.for) so the guard survives multiple
// independent imports of the SDK in the same process. Without this, a host
// app that depends on two copies of the SDK (e.g., via different transitive
// dependency paths) would patch http twice.
const INSTRUMENTATION_GUARD = Symbol.for('lynktrace.auto-instrumentation.registered');
const INSTRUMENTATION_GUARD_LEGACY = Symbol.for('pulse-sdk.auto-instrumentation.registered');
const TEARDOWN_REGISTRY = Symbol.for('lynktrace.auto-instrumentation.teardowns');
const TEARDOWN_REGISTRY_LEGACY = Symbol.for('pulse-sdk.auto-instrumentation.teardowns');
const UNREGISTER_FN = Symbol.for('lynktrace.auto-instrumentation.unregister');
const UNREGISTER_FN_LEGACY = Symbol.for('pulse-sdk.auto-instrumentation.unregister');
const BOOTSTRAP_GUARD = Symbol.for('lynktrace.auto-instrumentation.bootstrap');
const BOOTSTRAP_GUARD_LEGACY = Symbol.for('pulse-sdk.auto-instrumentation.bootstrap');
const ACTIVE_REGISTRY = Symbol.for('lynktrace.auto-instrumentation.registry');
const ACTIVE_REGISTRY_LEGACY = Symbol.for('pulse-sdk.auto-instrumentation.registry');
function getGlobalState() {
    return globalThis;
}
let pendingAsyncSetup = null;
/**
 * Wait for any asynchronous instrumentation setup (such as Axios ESM loader)
 * to complete before application code executes.
 */
export async function waitForPendingInstrumentations() {
    if (pendingAsyncSetup) {
        try {
            await pendingAsyncSetup;
        }
        catch { }
    }
}
function resolveInstrumentationOptions() {
    const configManager = ConfigManager.getInstance();
    const config = configManager.getConfig();
    const instr = config.instrumentation;
    const captureConfig = config.privacy.capture;
    const httpEnabled = instr.http;
    const httpsEnabled = instr.https;
    const expressEnabled = typeof instr.express === 'object'
        ? instr.express.enabled
        : instr.express;
    const fastifyConfig = typeof instr.fastify === 'object'
        ? instr.fastify
        : { enabled: instr.fastify, captureHooks: true, captureValidationErrors: true };
    const fetchEnabled = instr.fetch;
    const graphqlEnabled = typeof instr.graphql === 'object'
        ? instr.graphql.enabled
        : instr.graphql;
    const graphqlConfig = typeof instr.graphql === 'object'
        ? { enabled: graphqlEnabled, captureResolvers: instr.graphql.captureResolvers }
        : { enabled: graphqlEnabled, captureResolvers: true };
    const prismaEnabled = typeof instr.prisma === 'object'
        ? instr.prisma.enabled
        : instr.prisma;
    const prismaConfig = typeof instr.prisma === 'object'
        ? { enabled: prismaEnabled, captureQueries: instr.prisma.captureQueries, captureParams: instr.prisma.captureParams }
        : { enabled: prismaEnabled, captureQueries: true, captureParams: false };
    const mongodbEnabled = instr.mongodb;
    const redisEnabled = typeof instr.redis === 'object' ? instr.redis.enabled : Boolean(instr.redis);
    const redisConfig = typeof instr.redis === 'object'
        ? instr.redis
        : { enabled: redisEnabled, keyPolicy: 'sanitized-key' };
    const axiosEnabled = instr.axios;
    // BullMQ accepts an object form in remote config so the control plane can
    // tune span verbosity without a redeploy. Boolean form = enabled with
    // library defaults.
    const bullmqEnabled = typeof instr.bullmq === 'object'
        ? instr.bullmq.enabled
        : instr.bullmq;
    const bullmqRemote = typeof instr.bullmq === 'object' ? instr.bullmq : undefined;
    const bullmqConfig = {
        enabled: bullmqEnabled,
        emitCreateSpansForBulk: bullmqRemote?.emitCreateSpansForBulk ?? true,
        emitCreateSpansForFlow: bullmqRemote?.emitCreateSpansForFlow ?? true,
        requireParentSpanForPublish: bullmqRemote?.requireParentSpanForPublish ?? false,
    };
    const pgEnabled = typeof instr.pg === 'object' ? instr.pg.enabled : instr.pg;
    const pgConfig = typeof instr.pg === 'object'
        ? {
            enabled: pgEnabled,
            captureQueries: instr.pg.captureQueries,
            captureParams: instr.pg.captureParams,
        }
        : { enabled: pgEnabled, captureQueries: false, captureParams: false };
    const mysql2Enabled = typeof instr.mysql2 === 'object' ? instr.mysql2.enabled : instr.mysql2;
    const mysql2Config = typeof instr.mysql2 === 'object'
        ? { enabled: mysql2Enabled, captureQueries: instr.mysql2.captureQueries }
        : { enabled: mysql2Enabled, captureQueries: false };
    const eventEmitterPatchEnabled = instr.eventEmitterPatch;
    const automaticTracingAllowed = EntitlementGate.isAllowed('tracing');
    const contextBindingAllowed = automaticTracingAllowed || EntitlementGate.isAllowed('customSpans');
    // New Databases & ORMs
    const dynamodbEnabled = typeof instr.dynamodb === 'object' ? instr.dynamodb.enabled : (instr.dynamodb ?? true);
    const dynamodbConfig = typeof instr.dynamodb === 'object'
        ? { enabled: dynamodbEnabled, captureQueries: instr.dynamodb.captureQueries ?? true, captureParams: instr.dynamodb.captureParams ?? false }
        : { enabled: dynamodbEnabled, captureQueries: true, captureParams: false };
    const cassandraEnabled = typeof instr.cassandra === 'object' ? instr.cassandra.enabled : (instr.cassandra ?? true);
    const cassandraConfig = typeof instr.cassandra === 'object'
        ? { enabled: cassandraEnabled, captureQueries: instr.cassandra.captureQueries ?? true, captureParams: instr.cassandra.captureParams ?? false }
        : { enabled: cassandraEnabled, captureQueries: true, captureParams: false };
    const elasticsearchEnabled = typeof instr.elasticsearch === 'object' ? instr.elasticsearch.enabled : (instr.elasticsearch ?? true);
    const elasticsearchConfig = typeof instr.elasticsearch === 'object'
        ? { enabled: elasticsearchEnabled, captureQueries: instr.elasticsearch.captureQueries ?? true }
        : { enabled: elasticsearchEnabled, captureQueries: true };
    const mssqlEnabled = typeof instr.mssql === 'object' ? instr.mssql.enabled : (instr.mssql ?? true);
    const mssqlConfig = typeof instr.mssql === 'object'
        ? { enabled: mssqlEnabled, captureQueries: instr.mssql.captureQueries ?? true, captureParams: instr.mssql.captureParams ?? false }
        : { enabled: mssqlEnabled, captureQueries: true, captureParams: false };
    const sqliteEnabled = typeof instr.sqlite === 'object' ? instr.sqlite.enabled : (instr.sqlite ?? true);
    const sqliteConfig = typeof instr.sqlite === 'object'
        ? { enabled: sqliteEnabled, captureQueries: instr.sqlite.captureQueries ?? true, captureParams: instr.sqlite.captureParams ?? false }
        : { enabled: sqliteEnabled, captureQueries: true, captureParams: false };
    const typeormEnabled = typeof instr.typeorm === 'object' ? instr.typeorm.enabled : (instr.typeorm ?? true);
    const typeormConfig = typeof instr.typeorm === 'object'
        ? { enabled: typeormEnabled, captureQueries: instr.typeorm.captureQueries ?? true, captureParams: instr.typeorm.captureParams ?? false }
        : { enabled: typeormEnabled, captureQueries: true, captureParams: false };
    const drizzleEnabled = typeof instr.drizzle === 'object' ? instr.drizzle.enabled : (instr.drizzle ?? true);
    const drizzleConfig = typeof instr.drizzle === 'object'
        ? { enabled: drizzleEnabled, captureQueries: instr.drizzle.captureQueries ?? true, captureParams: instr.drizzle.captureParams ?? false }
        : { enabled: drizzleEnabled, captureQueries: true, captureParams: false };
    const mikroormEnabled = instr.mikroorm ?? true;
    const sequelizeEnabled = instr.sequelize ?? true;
    const knexEnabled = instr.knex ?? true;
    // New Messaging
    const kafkaEnabled = typeof instr.kafkajs === 'object' ? instr.kafkajs.enabled : (instr.kafkajs ?? true);
    const kafkaConfig = typeof instr.kafkajs === 'object'
        ? { enabled: kafkaEnabled, emitConsumerBatchSpans: instr.kafkajs.emitConsumerBatchSpans ?? true, captureMessageKey: instr.kafkajs.captureMessageKey ?? false }
        : { enabled: kafkaEnabled, emitConsumerBatchSpans: true, captureMessageKey: false };
    const amqpEnabled = typeof instr.amqplib === 'object' ? instr.amqplib.enabled : (instr.amqplib ?? true);
    const amqpConfig = typeof instr.amqplib === 'object'
        ? { enabled: amqpEnabled, captureMessageData: instr.amqplib.captureMessageData ?? false }
        : { enabled: amqpEnabled, captureMessageData: false };
    const sqsEnabled = instr.sqs ?? true;
    const snsEnabled = instr.sns ?? true;
    const pubsubEnabled = instr.pubsub ?? true;
    // RPC & Infrastructure
    const grpcEnabled = instr.grpc ?? true;
    const nestjsEnabled = instr.nestjs ?? true;
    const dnsEnabled = typeof instr.dns === 'object' ? instr.dns.enabled : (instr.dns ?? false);
    return {
        http: httpEnabled && automaticTracingAllowed,
        https: httpsEnabled && automaticTracingAllowed,
        express: expressEnabled && automaticTracingAllowed,
        fastify: fastifyConfig.enabled && automaticTracingAllowed,
        undici: fetchEnabled && automaticTracingAllowed,
        graphql: graphqlConfig.enabled && automaticTracingAllowed,
        graphqlConfig,
        prisma: prismaConfig.enabled && automaticTracingAllowed,
        prismaConfig,
        mongodb: mongodbEnabled && automaticTracingAllowed,
        mongoose: mongodbEnabled && automaticTracingAllowed,
        redis: redisEnabled && automaticTracingAllowed,
        ioredis: redisEnabled && automaticTracingAllowed,
        redisConfig,
        bullmq: bullmqConfig.enabled && automaticTracingAllowed,
        bullmqConfig,
        axios: axiosEnabled && automaticTracingAllowed,
        pg: pgConfig.enabled && automaticTracingAllowed,
        pgConfig,
        mysql2: mysql2Config.enabled && automaticTracingAllowed,
        mysql2Config,
        dynamodb: dynamodbConfig.enabled && automaticTracingAllowed,
        dynamodbConfig,
        cassandra: cassandraConfig.enabled && automaticTracingAllowed,
        cassandraConfig,
        elasticsearch: elasticsearchConfig.enabled && automaticTracingAllowed,
        elasticsearchConfig,
        mssql: mssqlConfig.enabled && automaticTracingAllowed,
        mssqlConfig,
        sqlite: sqliteConfig.enabled && automaticTracingAllowed,
        sqliteConfig,
        typeorm: typeormConfig.enabled && automaticTracingAllowed,
        typeormConfig,
        drizzle: drizzleConfig.enabled && automaticTracingAllowed,
        drizzleConfig,
        mikroorm: mikroormEnabled && automaticTracingAllowed,
        sequelize: sequelizeEnabled && automaticTracingAllowed,
        knex: knexEnabled && automaticTracingAllowed,
        kafkajs: kafkaConfig.enabled && automaticTracingAllowed,
        kafkaConfig,
        amqplib: amqpConfig.enabled && automaticTracingAllowed,
        amqpConfig,
        sqs: sqsEnabled && automaticTracingAllowed,
        sns: snsEnabled && automaticTracingAllowed,
        pubsub: pubsubEnabled && automaticTracingAllowed,
        grpc: grpcEnabled && automaticTracingAllowed,
        nestjs: nestjsEnabled && automaticTracingAllowed,
        dns: dnsEnabled && automaticTracingAllowed,
        eventEmitterPatch: eventEmitterPatchEnabled && contextBindingAllowed,
        fastifyConfig: {
            captureHooks: fastifyConfig.captureHooks,
            captureValidationErrors: fastifyConfig.captureValidationErrors,
        },
        captureConfig,
    };
}
function createHttpInstrumentationInstance(httpEnabled, httpsEnabled) {
    return new HttpInstrumentation({
        ignoreOutgoingRequestHook: (request) => {
            const activeCtx = context.active();
            if (activeCtx.getValue(SUPPRESS_INNER_HTTP_LYNKTRACE) === true || activeCtx.getValue(SUPPRESS_INNER_HTTP) === true)
                return true;
            if (!client.initialized)
                return false;
            try {
                if (!isRequestProtocolEnabled(request, httpEnabled, httpsEnabled))
                    return true;
                const reqCheck = request;
                if (typeof reqCheck.getHeader === 'function') {
                    const internalVal = reqCheck.getHeader('x-lynktrace-internal') ?? reqCheck.getHeader('x-pulse-internal');
                    if (internalVal === '1' || internalVal === 1)
                        return true;
                }
                if (reqCheck.headers) {
                    if (reqCheck.headers['x-lynktrace-internal'] === '1' || reqCheck.headers['x-pulse-internal'] === '1') {
                        return true;
                    }
                }
                let target = null;
                if (typeof request === 'string') {
                    try {
                        target = new URL(request);
                    }
                    catch { }
                }
                else if (request && typeof request === 'object') {
                    const req = request;
                    const candidate = String(req.href ?? req.url ?? '');
                    if (candidate.startsWith('http://') || candidate.startsWith('https://')) {
                        try {
                            target = new URL(candidate);
                        }
                        catch { }
                    }
                    else {
                        const host = String(req.host ?? req.hostname ?? 'localhost');
                        const protocol = String(req.protocol ?? 'http:');
                        const path = String(req.path ?? req.pathname ?? '/');
                        try {
                            target = new URL(`${protocol.endsWith(':') ? protocol : protocol + ':'}//${host}${path}`);
                        }
                        catch { }
                    }
                }
                if (!target)
                    return false;
                const configMgr = ConfigManager.getCurrent();
                if (configMgr?.isInternalEndpoint(target))
                    return true;
                const routes = configMgr?.getConfigOrNull()?.transport?.routes;
                if (!routes)
                    return false;
                return Object.values(routes).some(route => isInternalSdkUrl(target, new URL(route.url)));
            }
            catch {
                return false;
            }
        },
        ignoreIncomingRequestHook: (request) => !isRequestProtocolEnabled(request, httpEnabled, httpsEnabled),
        // ─── Defensive Lifecycle Hooks ───────────────────────────────
        // Guard against socket destruction race conditions in OTel's HTTP instrumentation.
        requestHook: (span, request) => {
            try {
                const req = request;
                req.__lynktraceServerSpan = span;
                req.__pulseServerSpan = span;
                const socket = req.socket;
                if (socket && (socket.destroyed === true || socket.writable === false)) {
                    span.setAttribute('lynktrace.http.socket_state', 'destroyed');
                    span.setAttribute('pulse.http.socket_state', 'destroyed');
                }
                // P0.3: Root HTTP Server Span Lifecycle Coordination
                // Ensure root HTTP server span remains open until all request-scoped async operations
                // (database queries, external calls, async route handler continuation) complete.
                const spanAny = span;
                const isServerSpan = spanAny['kind'] === SpanKind.SERVER || (!('getHeader' in request) && 'socket' in request);
                if (isServerSpan && typeof span.end === 'function') {
                    const ctx = span.spanContext();
                    const traceId = ctx?.traceId;
                    if (traceId) {
                        const originalEnd = span.end.bind(span);
                        let ended = false;
                        span.end = function lynktraceInterceptedRootSpanEnd(...args) {
                            if (ended)
                                return;
                            const aggregator = getTraceAggregator();
                            const activeCount = aggregator.getActiveSpanCount(traceId);
                            const executeEnd = (delayed = false) => {
                                if (ended)
                                    return;
                                ended = true;
                                // If delayed waiting for active children, omit stale responseEndTime in args
                                // so OpenTelemetry stamps the actual current monotonic timestamp.
                                if (delayed) {
                                    originalEnd.apply(this);
                                }
                                else {
                                    originalEnd.apply(this, args.length > 0 ? args : undefined);
                                }
                            };
                            if (activeCount > 1) {
                                aggregator.waitForActiveChildren(traceId, () => executeEnd(true), 10000);
                            }
                            else {
                                executeEnd(false);
                            }
                        };
                    }
                }
            }
            catch {
                // Never crash from a hook — isolated by design
            }
        },
        responseHook: (span, response) => {
            try {
                const res = response;
                if (res.statusCode == null) {
                    span.setAttribute('lynktrace.http.incomplete_response', true);
                    span.setAttribute('pulse.http.incomplete_response', true);
                }
            }
            catch {
                // Never crash from a hook
            }
        },
    });
}
function createUndiciInstrumentationInstance() {
    return new UndiciInstrumentation({
        ignoreRequestHook: (request) => {
            const activeCtx = context.active();
            if (activeCtx.getValue(SUPPRESS_INNER_HTTP_LYNKTRACE) === true || activeCtx.getValue(SUPPRESS_INNER_HTTP) === true)
                return true;
            if (!client.initialized)
                return false;
            try {
                const reqCheck = request;
                if (reqCheck.headers) {
                    if (Array.isArray(reqCheck.headers)) {
                        for (let i = 0; i < reqCheck.headers.length; i += 2) {
                            const h = reqCheck.headers[i]?.toLowerCase();
                            if ((h === 'x-lynktrace-internal' || h === 'x-pulse-internal') && reqCheck.headers[i + 1] === '1') {
                                return true;
                            }
                        }
                    }
                    else if (reqCheck.headers['x-lynktrace-internal'] === '1' || reqCheck.headers['x-pulse-internal'] === '1') {
                        return true;
                    }
                }
                const req = request;
                const rawOrigin = req.origin ?? req['origin'];
                const rawPath = req.path ?? req['path'] ?? req.pathname;
                const url = rawOrigin
                    ? new URL(String(rawPath ?? '/'), String(rawOrigin))
                    : new URL(String(req.url ?? ''));
                const configMgr = ConfigManager.getCurrent();
                if (configMgr?.isInternalEndpoint(url))
                    return true;
                const routes = configMgr?.getConfigOrNull()?.transport?.routes;
                if (!routes)
                    return false;
                return Object.values(routes).some(route => isInternalSdkUrl(url, new URL(route.url)));
            }
            catch {
                return false;
            }
        },
    });
}
/**
 * Register all configured auto-instrumentations.
 * Idempotent: a second call without an intervening reset is a no-op.
 * Upgrades bootstrap hooks in-place without unregistering or losing loaded module monkey-patches.
 */
export function registerAutoInstrumentations() {
    const g = getGlobalState();
    const isGuarded = (g[INSTRUMENTATION_GUARD] || g[INSTRUMENTATION_GUARD_LEGACY]) && !(g[BOOTSTRAP_GUARD] || g[BOOTSTRAP_GUARD_LEGACY]);
    if (isGuarded)
        return;
    const logger = getLogger();
    const resolved = resolveInstrumentationOptions();
    const activeTracerProvider = trace.getTracerProvider();
    // ─── Case 1: Upgrading from bootstrap hooks (Preserve patches in-place) ──
    const isBootstrap = (g[BOOTSTRAP_GUARD] || g[BOOTSTRAP_GUARD_LEGACY]) && (g[ACTIVE_REGISTRY] || g[ACTIVE_REGISTRY_LEGACY]);
    if (isBootstrap) {
        delete g[BOOTSTRAP_GUARD];
        delete g[BOOTSTRAP_GUARD_LEGACY];
        g[INSTRUMENTATION_GUARD] = true;
        g[INSTRUMENTATION_GUARD_LEGACY] = true;
        const registry = g[ACTIVE_REGISTRY] ?? g[ACTIVE_REGISTRY_LEGACY];
        for (const [name, inst] of Object.entries(registry)) {
            if (!inst)
                continue;
            // 1. Attach active TracerProvider so all calls emit to the real provider
            if (typeof inst.setTracerProvider === 'function') {
                try {
                    ;
                    inst.setTracerProvider(activeTracerProvider);
                }
                catch { }
            }
            // 2. Reflect enabled/disabled status from remote config
            const isEnabled = name === 'mongoose'
                ? Boolean(resolved.mongodb)
                : name === 'ioredis'
                    ? Boolean(resolved.redis)
                    : Boolean(resolved[name]);
            if (!isEnabled) {
                if (typeof inst.disable === 'function') {
                    try {
                        ;
                        inst.disable();
                    }
                    catch { }
                }
            }
            else {
                if (typeof inst.enable === 'function' && typeof inst.isEnabled === 'function' && !inst.isEnabled()) {
                    try {
                        ;
                        inst.enable();
                    }
                    catch { }
                }
                // 3. Update dynamic configs in-place without unwrapping module hooks
                if (typeof inst.setConfig === 'function') {
                    try {
                        if (name === 'mongodb') {
                            ;
                            inst.setConfig({
                                enabled: true,
                                enhancedDatabaseReporting: resolved.captureConfig.body,
                                requireParentSpan: false,
                            });
                        }
                        else if (name === 'pg') {
                            ;
                            inst.setConfig({
                                enabled: true,
                                enhancedDatabaseReporting: resolved.pgConfig.captureParams || resolved.pgConfig.captureQueries || resolved.captureConfig.body,
                                requireParentSpan: false,
                            });
                        }
                        else if (name === 'prisma') {
                            ;
                            inst.setConfig({
                                enabled: true,
                                ...(resolved.prismaConfig.captureQueries ? {} : { ignoreSpanTypes: [/^prisma:engine:/] }),
                            });
                        }
                    }
                    catch { }
                }
                if (name === 'mongoose' && typeof inst.updateCaptureConfig === 'function') {
                    try {
                        ;
                        inst.updateCaptureConfig(resolved.captureConfig);
                    }
                    catch { }
                }
            }
        }
        // 4. Setup Axios if enabled (async module setup not done in bootstrap)
        if (resolved.axios && !registry.axios) {
            const axiosInstrumentation = createAxiosInstrumentation(true, {
                captureRequestData: resolved.captureConfig.body,
                captureResponseData: resolved.captureConfig.response,
            }, resolved.captureConfig);
            if (axiosInstrumentation) {
                g[TEARDOWN_REGISTRY].push(axiosInstrumentation.teardown);
                registry.axios = axiosInstrumentation;
                pendingAsyncSetup = axiosInstrumentation.setup().catch((err) => {
                    logger.warn('Axios instrumentation setup failed', { error: String(err) });
                });
            }
        }
        if (resolved.eventEmitterPatch) {
            patchEventEmitter();
        }
        installHttpLifecycleGuard();
        logger.info('Auto-instrumentations upgraded from bootstrap with remote config', {
            count: Object.keys(registry).length,
            mongodb: resolved.mongodb,
            pg: resolved.pg,
            prisma: resolved.prisma,
        });
        return;
    }
    // ─── Case 2: Standalone init (Bootstrap was not run) ──────────────────────
    g[INSTRUMENTATION_GUARD] = true;
    g[INSTRUMENTATION_GUARD_LEGACY] = true;
    delete g[BOOTSTRAP_GUARD];
    delete g[BOOTSTRAP_GUARD_LEGACY];
    g[TEARDOWN_REGISTRY] = [];
    g[TEARDOWN_REGISTRY_LEGACY] = g[TEARDOWN_REGISTRY];
    try {
        registerEsmLoaderHooks();
    }
    catch (err) {
        logger.debug('ESM loader hooks registration failed', { error: String(err) });
    }
    const registry = {};
    const safeRegister = (name, factory) => {
        try {
            const inst = factory();
            if (inst)
                registry[name] = inst;
        }
        catch (err) {
            logger.debug(`Auto-instrumentation creation skipped for ${name}`, { error: String(err) });
        }
    };
    if (resolved.http || resolved.https) {
        safeRegister('http', () => createHttpInstrumentationInstance(resolved.http, resolved.https));
    }
    if (resolved.express) {
        safeRegister('express', () => new ExpressInstrumentation());
    }
    if (resolved.fastify) {
        safeRegister('fastify', () => new FastifyOtelInstrumentation({
            registerOnInitialization: true,
            instrumentHooks: resolved.fastifyConfig.captureHooks,
        }));
    }
    if (resolved.undici) {
        safeRegister('undici', () => createUndiciInstrumentationInstance());
    }
    if (resolved.graphql) {
        safeRegister('graphql', () => createGraphQLInstrumentation(resolved.graphqlConfig, resolved.graphqlConfig));
    }
    if (resolved.prisma) {
        safeRegister('prisma', () => createPrismaInstrumentation(resolved.prismaConfig, resolved.prismaConfig));
    }
    if (resolved.mongodb) {
        safeRegister('mongodb', () => createMongoDBInstrumentation(true, { enhancedDatabaseReporting: resolved.captureConfig.body, requireParentSpan: false }, resolved.captureConfig));
        safeRegister('mongoose', () => createMongooseInstrumentation(true, resolved.captureConfig));
    }
    if (resolved.redis) {
        safeRegister('redis', () => createRedisInstrumentation(true, resolved.redisConfig, resolved.captureConfig));
        safeRegister('ioredis', () => createIORedisInstrumentation(true, resolved.redisConfig, resolved.captureConfig));
    }
    if (resolved.bullmq) {
        safeRegister('bullmq', () => createBullMQInstrumentation(true, resolved.bullmqConfig, resolved.captureConfig));
    }
    if (resolved.axios) {
        try {
            const axiosInstrumentation = createAxiosInstrumentation(true, {
                captureRequestData: resolved.captureConfig.body,
                captureResponseData: resolved.captureConfig.response,
            }, resolved.captureConfig);
            if (axiosInstrumentation) {
                g[TEARDOWN_REGISTRY].push(axiosInstrumentation.teardown);
                registry.axios = axiosInstrumentation;
                pendingAsyncSetup = axiosInstrumentation.setup().catch((err) => {
                    logger.warn('Axios instrumentation setup failed', { error: String(err) });
                });
            }
        }
        catch (err) {
            logger.debug('Axios instrumentation creation skipped', { error: String(err) });
        }
    }
    if (resolved.pg) {
        safeRegister('pg', () => createPgInstrumentation(true, { captureQueries: resolved.pgConfig.captureQueries, captureParams: resolved.pgConfig.captureParams, requireParentSpan: false }, resolved.captureConfig));
    }
    if (resolved.mysql2) {
        safeRegister('mysql2', () => createMySQLInstrumentation(true, { captureQueries: resolved.mysql2Config.captureQueries }, resolved.captureConfig));
    }
    safeRegister('nodemailer', () => createNodemailerInstrumentation(true, {}, resolved.captureConfig));
    if (resolved.dynamodb) {
        safeRegister('dynamodb', () => createDynamoDBInstrumentation(true, resolved.dynamodbConfig, resolved.captureConfig));
    }
    if (resolved.cassandra) {
        safeRegister('cassandra', () => createCassandraInstrumentation(true, resolved.cassandraConfig, resolved.captureConfig));
    }
    if (resolved.elasticsearch) {
        safeRegister('elasticsearch', () => createElasticsearchInstrumentation(true, resolved.elasticsearchConfig, resolved.captureConfig));
    }
    if (resolved.mssql) {
        safeRegister('mssql', () => createMSSQLInstrumentation(true, resolved.mssqlConfig, resolved.captureConfig));
    }
    if (resolved.sqlite) {
        safeRegister('sqlite', () => createSQLiteInstrumentation(true, resolved.sqliteConfig, resolved.captureConfig));
    }
    if (resolved.typeorm) {
        safeRegister('typeorm', () => createTypeORMInstrumentation(true, resolved.typeormConfig, resolved.captureConfig));
    }
    if (resolved.drizzle) {
        safeRegister('drizzle', () => createDrizzleInstrumentation(true, resolved.drizzleConfig, resolved.captureConfig));
    }
    if (resolved.mikroorm) {
        safeRegister('mikroorm', () => createMikroORMInstrumentation(true));
    }
    if (resolved.sequelize) {
        safeRegister('sequelize', () => createSequelizeInstrumentation(true));
    }
    if (resolved.knex) {
        safeRegister('knex', () => createKnexInstrumentation(true));
    }
    if (resolved.kafkajs) {
        safeRegister('kafkajs', () => createKafkaInstrumentation(true, resolved.kafkaConfig, resolved.captureConfig));
    }
    if (resolved.amqplib) {
        safeRegister('amqplib', () => createAMQPInstrumentation(true, resolved.amqpConfig, resolved.captureConfig));
    }
    if (resolved.sqs || resolved.sns) {
        safeRegister('sqs_sns', () => createSqsSnsInstrumentation(resolved.sqs, resolved.sns));
    }
    if (resolved.pubsub) {
        safeRegister('pubsub', () => createPubSubInstrumentation(true));
    }
    if (resolved.grpc) {
        safeRegister('grpc', () => createGrpcInstrumentation(true));
    }
    if (resolved.nestjs) {
        safeRegister('nestjs', () => createNestJSInstrumentation(true));
    }
    if (resolved.dns) {
        safeRegister('dns', () => createDNSInstrumentation(true));
    }
    g[ACTIVE_REGISTRY] = registry;
    g[ACTIVE_REGISTRY_LEGACY] = registry;
    const otelInstrumentations = Object.values(registry).filter((inst) => Boolean(inst && typeof inst.setTracerProvider === 'function'));
    if (otelInstrumentations.length > 0) {
        try {
            const unreg = registerInstrumentations({
                instrumentations: otelInstrumentations,
                tracerProvider: activeTracerProvider,
            });
            g[UNREGISTER_FN] = unreg;
            g[UNREGISTER_FN_LEGACY] = unreg;
        }
        catch (err) {
            logger.debug('registerInstrumentations threw during auto-instrumentation', { error: String(err) });
        }
    }
    if (resolved.eventEmitterPatch) {
        try {
            patchEventEmitter();
        }
        catch (err) {
            logger.debug('patchEventEmitter threw during auto-instrumentation', { error: String(err) });
        }
    }
    try {
        installHttpLifecycleGuard();
    }
    catch (err) {
        logger.debug('installHttpLifecycleGuard threw during auto-instrumentation', { error: String(err) });
    }
    logger.info('Auto-instrumentations registered (remote-config-driven)', {
        count: otelInstrumentations.length,
        mongodb: resolved.mongodb,
        pg: resolved.pg,
        prisma: resolved.prisma,
    });
}
/**
 * Install safe module-load hooks as soon as the SDK package is imported.
 *
 * This closes the common ESM/CJS race where application code imports LynkTrace,
 * starts `createSDK()`, and imports DB clients while the one remote-config
 * request is still in flight. The early hooks use privacy-safe defaults and
 * a no-op/proxy tracer until `initTracer()` installs the real provider. Once
 * remote config arrives, `registerAutoInstrumentations()` upgrades the same
 * hooks in-place without unregistering or unwrapping modules.
 *
 * SEC-08 Guarantees:
 * - Every instrumentation factory is individually isolated in a safe try-catch.
 * - Missing or throwing optional dependencies never bubble up.
 * - The entire bootstrap routine is wrapped in a fail-open boundary so that
 *   importing `@lynktrace/node` can never crash host application startup.
 */
export function registerBootstrapAutoInstrumentations() {
    const g = getGlobalState();
    if (g[INSTRUMENTATION_GUARD] || g[INSTRUMENTATION_GUARD_LEGACY])
        return;
    const logger = getLogger();
    try {
        g[INSTRUMENTATION_GUARD] = true;
        g[INSTRUMENTATION_GUARD_LEGACY] = true;
        g[BOOTSTRAP_GUARD] = true;
        g[BOOTSTRAP_GUARD_LEGACY] = true;
        g[TEARDOWN_REGISTRY] = [];
        g[TEARDOWN_REGISTRY_LEGACY] = g[TEARDOWN_REGISTRY];
        // Ensure Node.js ESM customization hooks are registered as early as possible
        try {
            registerEsmLoaderHooks();
        }
        catch (err) {
            logger.debug('ESM loader hooks registration failed during bootstrap', { error: String(err) });
        }
        const captureConfig = {
            headers: false,
            body: false,
            response: false,
            query: false,
            cookies: false,
        };
        const registry = {};
        const safeRegister = (name, factory) => {
            try {
                const inst = factory();
                if (inst)
                    registry[name] = inst;
            }
            catch (err) {
                logger.debug(`Bootstrap auto-instrumentation skipped for ${name}`, { error: String(err) });
            }
        };
        safeRegister('http', () => createHttpInstrumentationInstance(true, true));
        safeRegister('express', () => new ExpressInstrumentation());
        safeRegister('fastify', () => new FastifyOtelInstrumentation({
            registerOnInitialization: true,
            instrumentHooks: true,
        }));
        safeRegister('undici', () => createUndiciInstrumentationInstance());
        safeRegister('graphql', () => createGraphQLInstrumentation(true, { enabled: true, captureResolvers: true }));
        safeRegister('prisma', () => createPrismaInstrumentation(true, { enabled: true, captureQueries: true, captureParams: false }));
        safeRegister('mongodb', () => createMongoDBInstrumentation(true, { enhancedDatabaseReporting: false, requireParentSpan: false }, captureConfig));
        safeRegister('mongoose', () => createMongooseInstrumentation(true, captureConfig));
        safeRegister('redis', () => createRedisInstrumentation(true, {}, captureConfig));
        safeRegister('ioredis', () => createIORedisInstrumentation(true, {}, captureConfig));
        safeRegister('bullmq', () => createBullMQInstrumentation(true, {
            enabled: true,
            emitCreateSpansForBulk: true,
            emitCreateSpansForFlow: true,
            requireParentSpanForPublish: false,
        }, captureConfig));
        safeRegister('pg', () => createPgInstrumentation(true, { captureQueries: false, captureParams: false, requireParentSpan: false }, captureConfig));
        safeRegister('mysql2', () => createMySQLInstrumentation(true, { captureQueries: false }, captureConfig));
        safeRegister('nodemailer', () => createNodemailerInstrumentation(true, {}, captureConfig));
        safeRegister('dynamodb', () => createDynamoDBInstrumentation(true, { captureQueries: false, captureParams: false }, captureConfig));
        safeRegister('cassandra', () => createCassandraInstrumentation(true, { captureQueries: false, captureParams: false }, captureConfig));
        safeRegister('elasticsearch', () => createElasticsearchInstrumentation(true, { captureQueries: false }, captureConfig));
        safeRegister('mssql', () => createMSSQLInstrumentation(true, { captureQueries: false, captureParams: false }, captureConfig));
        safeRegister('sqlite', () => createSQLiteInstrumentation(true, { captureQueries: false, captureParams: false }, captureConfig));
        safeRegister('typeorm', () => createTypeORMInstrumentation(true, { captureQueries: false, captureParams: false }, captureConfig));
        safeRegister('drizzle', () => createDrizzleInstrumentation(true, { captureQueries: false, captureParams: false }, captureConfig));
        safeRegister('mikroorm', () => createMikroORMInstrumentation(true));
        safeRegister('sequelize', () => createSequelizeInstrumentation(true));
        safeRegister('knex', () => createKnexInstrumentation(true));
        safeRegister('kafkajs', () => createKafkaInstrumentation(true, { emitConsumerBatchSpans: true, captureMessageKey: false }, captureConfig));
        safeRegister('amqplib', () => createAMQPInstrumentation(true, { captureMessageData: false }, captureConfig));
        safeRegister('sqs_sns', () => createSqsSnsInstrumentation(true, true));
        safeRegister('pubsub', () => createPubSubInstrumentation(true));
        safeRegister('grpc', () => createGrpcInstrumentation(true));
        safeRegister('nestjs', () => createNestJSInstrumentation(true));
        safeRegister('dns', () => createDNSInstrumentation(false));
        const instrumentations = Object.values(registry).filter((inst) => Boolean(inst && typeof inst.setTracerProvider === 'function'));
        if (instrumentations.length > 0) {
            try {
                const unreg = registerInstrumentations({
                    instrumentations: instrumentations,
                });
                g[UNREGISTER_FN] = unreg;
                g[UNREGISTER_FN_LEGACY] = unreg;
            }
            catch (err) {
                logger.debug('registerInstrumentations threw during bootstrap', { error: String(err) });
            }
        }
        g[ACTIVE_REGISTRY] = registry;
        g[ACTIVE_REGISTRY_LEGACY] = registry;
        // NOTE: patchEventEmitter() is intentionally NOT called during bootstrap.
        // Global prototype patching must be strictly governed by configuration.
        try {
            installHttpLifecycleGuard();
        }
        catch (err) {
            logger.debug('installHttpLifecycleGuard threw during bootstrap', { error: String(err) });
        }
        logger.debug('Bootstrap auto-instrumentation hooks registered before remote config', {
            count: instrumentations.length,
        });
    }
    catch (outerErr) {
        // Top-level fail-open boundary: never crash application module import (SEC-08)
        delete g[INSTRUMENTATION_GUARD];
        delete g[INSTRUMENTATION_GUARD_LEGACY];
        delete g[BOOTSTRAP_GUARD];
        delete g[BOOTSTRAP_GUARD_LEGACY];
        logger.debug('Bootstrap auto-instrumentation failed open', { error: String(outerErr) });
    }
}
/**
 * Fully reset auto-instrumentation state.
 *
 * Steps:
 *   1. Run registered teardown callbacks (e.g., axios unwrap).
 *   2. Call the OTel unregister handle to disable every instrumentation.
 *   3. Clear the global guard so the next register call rebuilds from scratch.
 *
 * Errors in any single teardown are logged but never thrown — reset must
 * always succeed so a failed instrumentation cannot block SDK reinit.
 */
export function resetAutoInstrumentations() {
    const g = getGlobalState();
    const logger = getLogger();
    const teardowns = g[TEARDOWN_REGISTRY] ?? g[TEARDOWN_REGISTRY_LEGACY] ?? [];
    for (const teardown of teardowns) {
        try {
            const result = teardown();
            // Tolerate async teardowns; we don't await here because reset must be
            // synchronous to integrate with the unconditional shutdown phase.
            if (result && typeof result.catch === 'function') {
                ;
                result.catch(err => {
                    logger.warn('Auto-instrumentation teardown rejected', { error: err });
                });
            }
        }
        catch (err) {
            logger.warn('Auto-instrumentation teardown threw', { error: err });
        }
    }
    const unregister = g[UNREGISTER_FN] ?? g[UNREGISTER_FN_LEGACY];
    if (typeof unregister === 'function') {
        try {
            unregister();
        }
        catch (err) {
            logger.warn('Auto-instrumentation unregister threw', { error: err });
        }
    }
    delete g[INSTRUMENTATION_GUARD];
    delete g[INSTRUMENTATION_GUARD_LEGACY];
    delete g[BOOTSTRAP_GUARD];
    delete g[BOOTSTRAP_GUARD_LEGACY];
    delete g[TEARDOWN_REGISTRY];
    delete g[TEARDOWN_REGISTRY_LEGACY];
    delete g[UNREGISTER_FN];
    delete g[UNREGISTER_FN_LEGACY];
    delete g[ACTIVE_REGISTRY];
    delete g[ACTIVE_REGISTRY_LEGACY];
    pendingAsyncSetup = null;
    // Remove the EventEmitter context binding patch so the next register
    // call rebuilds from scratch with the latest configuration.
    try {
        unpatchEventEmitter();
    }
    catch (err) {
        logger.warn('EventEmitter unpatch threw', { error: err });
    }
    // Remove the HTTP lifecycle guard
    try {
        uninstallHttpLifecycleGuard();
    }
    catch (err) {
        logger.warn('HTTP lifecycle guard uninstall threw', { error: err });
    }
}
function isRequestProtocolEnabled(request, httpEnabled, httpsEnabled) {
    let https = false;
    try {
        if (typeof request === 'string' || request instanceof URL) {
            https = new URL(String(request)).protocol === 'https:';
        }
        else if (request && typeof request === 'object') {
            const value = request;
            const socket = value.socket;
            const agent = value.agent;
            const protocol = value.protocol ?? agent?.protocol;
            if (typeof protocol === 'string')
                https = protocol.toLowerCase() === 'https:';
            else if (socket?.encrypted === true)
                https = true;
            else {
                const candidate = value.href ?? value.origin;
                if (typeof candidate === 'string')
                    https = new URL(candidate).protocol === 'https:';
            }
        }
    }
    catch {
        // Unknown Node request shapes are treated as HTTP and still follow policy.
    }
    return https ? httpsEnabled : httpEnabled;
}
function isInternalSdkUrl(target, ingest) {
    return target.origin === ingest.origin && target.pathname === ingest.pathname;
}
export { GraphQLInstrumentation, MongoDBInstrumentation, RedisInstrumentation, PrismaInstrumentation, BullMQInstrumentation };
