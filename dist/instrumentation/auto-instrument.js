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
import { createAxiosInstrumentation } from './axios.js';
import { createPgInstrumentation } from './pg.js';
import { createMySQLInstrumentation } from './mysql.js';
import { createMongoDBInstrumentation } from './mongodb.js';
import { createRedisInstrumentation } from './redis.js';
import { createBullMQInstrumentation } from './bullmq.js';
import { createGraphQLInstrumentation } from './graphql.js';
import { createPrismaInstrumentation } from './prisma.js';
import { patchEventEmitter, unpatchEventEmitter } from './event-emitter-patch.js';
import { installHttpLifecycleGuard, uninstallHttpLifecycleGuard } from './http-lifecycle-guard.js';
// ─── Global Guard + Teardown Registry ───────────────────────────────────────
// We attach to globalThis (via Symbol.for) so the guard survives multiple
// independent imports of the SDK in the same process. Without this, a host
// app that depends on two copies of the SDK (e.g., via different transitive
// dependency paths) would patch http twice.
const INSTRUMENTATION_GUARD = Symbol.for('pulse-sdk.auto-instrumentation.registered');
const TEARDOWN_REGISTRY = Symbol.for('pulse-sdk.auto-instrumentation.teardowns');
const UNREGISTER_FN = Symbol.for('pulse-sdk.auto-instrumentation.unregister');
function getGlobalState() {
    return globalThis;
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
    const redisEnabled = instr.redis;
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
        redis: redisEnabled && automaticTracingAllowed,
        bullmq: bullmqConfig.enabled && automaticTracingAllowed,
        bullmqConfig,
        axios: axiosEnabled && automaticTracingAllowed,
        pg: pgConfig.enabled && automaticTracingAllowed,
        pgConfig,
        mysql2: mysql2Config.enabled && automaticTracingAllowed,
        mysql2Config,
        eventEmitterPatch: eventEmitterPatchEnabled && contextBindingAllowed,
        fastifyConfig: {
            captureHooks: fastifyConfig.captureHooks,
            captureValidationErrors: fastifyConfig.captureValidationErrors,
        },
        captureConfig,
    };
}
/**
 * Register all configured auto-instrumentations.
 * Idempotent: a second call without an intervening reset is a no-op.
 */
export function registerAutoInstrumentations() {
    const g = getGlobalState();
    if (g[INSTRUMENTATION_GUARD])
        return;
    g[INSTRUMENTATION_GUARD] = true;
    g[TEARDOWN_REGISTRY] = [];
    const logger = getLogger();
    const resolved = resolveInstrumentationOptions();
    const instrumentations = [];
    if (resolved.http || resolved.https) {
        instrumentations.push(new HttpInstrumentation({
            ignoreOutgoingRequestHook: (request) => {
                if (!client.initialized)
                    return false;
                try {
                    if (!isRequestProtocolEnabled(request, resolved.http, resolved.https))
                        return true;
                    const reqCheck = request;
                    if (typeof reqCheck.getHeader === 'function' && reqCheck.getHeader('x-pulse-internal') === '1') {
                        return true;
                    }
                    if (reqCheck.headers && reqCheck.headers['x-pulse-internal'] === '1') {
                        return true;
                    }
                    const routes = ConfigManager.getInstance().getConfig().transport.routes;
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
                    return Object.values(routes).some(route => isInternalSdkUrl(target, new URL(route.url)));
                }
                catch {
                    return false;
                }
            },
            ignoreIncomingRequestHook: (request) => !isRequestProtocolEnabled(request, resolved.http, resolved.https),
            // ─── Defensive Lifecycle Hooks ───────────────────────────────
            // Guard against the socket destruction race condition in OTel's
            // HTTP instrumentation. These hooks fire inside OTel's
            // safeExecuteInTheMiddle so exceptions are caught — but more
            // importantly they ensure the span gets diagnostic attributes
            // when the socket is in a degraded state, preventing the
            // downstream utils from crashing on null properties.
            requestHook: (span, request) => {
                try {
                    const req = request;
                    const socket = req.socket;
                    if (socket && (socket.destroyed === true || socket.writable === false)) {
                        span.setAttribute('pulse.http.socket_state', 'destroyed');
                    }
                }
                catch {
                    // Never crash from a hook — isolated by design
                }
            },
            responseHook: (span, response) => {
                try {
                    const res = response;
                    // Guard: if response object is incomplete (socket died before
                    // headers arrived), mark it so we can track in dashboards
                    if (res.statusCode == null) {
                        span.setAttribute('pulse.http.incomplete_response', true);
                    }
                }
                catch {
                    // Never crash from a hook
                }
            },
        }));
    }
    if (resolved.express) {
        instrumentations.push(new ExpressInstrumentation());
    }
    if (resolved.fastify) {
        instrumentations.push(new FastifyOtelInstrumentation({
            registerOnInitialization: true,
            instrumentHooks: resolved.fastifyConfig.captureHooks,
        }));
    }
    if (resolved.undici) {
        instrumentations.push(new UndiciInstrumentation({
            ignoreRequestHook: (request) => {
                if (!client.initialized)
                    return false;
                try {
                    const reqCheck = request;
                    if (reqCheck.headers) {
                        // In undici, headers can be an array of strings or an object
                        if (Array.isArray(reqCheck.headers)) {
                            for (let i = 0; i < reqCheck.headers.length; i += 2) {
                                if (reqCheck.headers[i]?.toLowerCase() === 'x-pulse-internal' && reqCheck.headers[i + 1] === '1') {
                                    return true;
                                }
                            }
                        }
                        else if (reqCheck.headers['x-pulse-internal'] === '1') {
                            return true;
                        }
                    }
                    const routes = ConfigManager.getInstance().getConfig().transport.routes;
                    const req = request;
                    const rawOrigin = req.origin ?? req['origin'];
                    const rawPath = req.path ?? req['path'] ?? req.pathname;
                    const url = rawOrigin
                        ? new URL(String(rawPath ?? '/'), String(rawOrigin))
                        : new URL(String(req.url ?? ''));
                    return Object.values(routes).some(route => isInternalSdkUrl(url, new URL(route.url)));
                }
                catch {
                    return false;
                }
            },
        }));
    }
    if (resolved.graphql) {
        const graphqlInstrumentation = createGraphQLInstrumentation(resolved.graphqlConfig, resolved.graphqlConfig);
        if (graphqlInstrumentation) {
            instrumentations.push(graphqlInstrumentation);
        }
    }
    if (resolved.prisma) {
        const prismaInstrumentation = createPrismaInstrumentation(resolved.prismaConfig, resolved.prismaConfig);
        if (prismaInstrumentation) {
            instrumentations.push(prismaInstrumentation);
        }
    }
    if (resolved.mongodb) {
        const mongoInstrumentation = createMongoDBInstrumentation(true, { enhancedDatabaseReporting: resolved.captureConfig.body }, resolved.captureConfig);
        if (mongoInstrumentation) {
            instrumentations.push(mongoInstrumentation);
        }
    }
    if (resolved.redis) {
        const redisInstrumentation = createRedisInstrumentation(true, {}, resolved.captureConfig);
        if (redisInstrumentation) {
            instrumentations.push(redisInstrumentation);
        }
    }
    if (resolved.bullmq) {
        const bullmqInstrumentation = createBullMQInstrumentation(true, resolved.bullmqConfig, resolved.captureConfig);
        if (bullmqInstrumentation) {
            instrumentations.push(bullmqInstrumentation);
        }
    }
    if (resolved.axios) {
        const axiosInstrumentation = createAxiosInstrumentation(true, {
            captureRequestData: resolved.captureConfig.body,
            captureResponseData: resolved.captureConfig.response,
        }, resolved.captureConfig);
        if (axiosInstrumentation) {
            // Track teardown so reset() can fully unwind the patch.
            g[TEARDOWN_REGISTRY].push(axiosInstrumentation.teardown);
            // setup() is async (ESM-safe module loading) — fire-and-forget but
            // surface any failure so we can detect setup races.
            void axiosInstrumentation.setup().catch((err) => {
                logger.warn('Axios instrumentation setup failed', { error: String(err) });
            });
        }
    }
    if (resolved.pg) {
        const pgInstrumentation = createPgInstrumentation(true, { captureQueries: resolved.pgConfig.captureQueries, captureParams: resolved.pgConfig.captureParams }, resolved.captureConfig);
        if (pgInstrumentation) {
            instrumentations.push(pgInstrumentation);
        }
    }
    if (resolved.mysql2) {
        const mysqlInstrumentation = createMySQLInstrumentation(true, { captureQueries: resolved.mysql2Config.captureQueries }, resolved.captureConfig);
        if (mysqlInstrumentation) {
            instrumentations.push(mysqlInstrumentation);
        }
    }
    const registeredInstrumentations = instrumentations.filter(Boolean);
    if (registeredInstrumentations.length > 0) {
        // Each call to registerInstrumentations returns an unregister function
        // that disables every instrumentation it registered. Capturing it lets
        // resetAutoInstrumentations() fully unwind monkey-patches on the next
        // shutdown — without this, the next init() would skip OTel registration
        // because the guard symbol was cleared but the patches remained live.
        const unregister = registerInstrumentations({
            instrumentations: registeredInstrumentations,
        });
        g[UNREGISTER_FN] = unregister;
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
        pg: resolved.pg,
        mysql2: resolved.mysql2,
        eventEmitterPatch: resolved.eventEmitterPatch,
        fastifyCaptureHooks: resolved.fastifyConfig.captureHooks,
        fastifyCaptureValidationErrors: resolved.fastifyConfig.captureValidationErrors,
        graphqlCaptureResolvers: resolved.graphqlConfig.captureResolvers,
        prismaCaptureQueries: resolved.prismaConfig.captureQueries,
        prismaCaptureParams: resolved.prismaConfig.captureParams,
        pgCaptureQueries: resolved.pgConfig.captureQueries,
        mysql2CaptureQueries: resolved.mysql2Config.captureQueries,
        count: registeredInstrumentations.length,
    });
    // Apply EventEmitter context binding patch so listeners preserve
    // the async context (trace ID, span) that was active at registration time.
    if (resolved.eventEmitterPatch) {
        patchEventEmitter();
    }
    // Install the HTTP lifecycle guard to protect against socket
    // destruction race conditions in OTel's HTTP instrumentation.
    installHttpLifecycleGuard();
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
    const teardowns = g[TEARDOWN_REGISTRY] ?? [];
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
    const unregister = g[UNREGISTER_FN];
    if (typeof unregister === 'function') {
        try {
            unregister();
        }
        catch (err) {
            logger.warn('Auto-instrumentation unregister threw', { error: err });
        }
    }
    delete g[INSTRUMENTATION_GUARD];
    delete g[TEARDOWN_REGISTRY];
    delete g[UNREGISTER_FN];
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
