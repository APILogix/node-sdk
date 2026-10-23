/**
 * @lynktrace/node — Enterprise observability SDK for Node.js.
 *
 * This file is the public API contract. Every symbol exported here is part
 * of the supported surface and follows semver.
 *
 * Internal engines (ConfigManager, KillswitchEngine, FeatureController,
 * SamplingEngine, LimitsEngine, SecurityScrubber, TransportRouter, etc.)
 * are deliberately NOT exported from this module. They are available via
 * the explicit, no-stability-guarantee sub-path:
 *
 *     import { KillswitchEngine } from '@lynktrace/node/internals'
 *
 * Typical usage:
 *
 *     import { init, captureException, lynktraceMiddleware } from '@lynktrace/node'
 *
 *     await init({ apiKey: process.env.LYNKTRACE_API_KEY ?? process.env.PULSE_API_KEY! })
 *     app.use(lynktraceMiddleware())
 */
export { init } from './core/init.js';
export { BACKEND_BASE_URL } from './constants/defaults.js';
import { init } from './core/init.js';
import { flush, shutdown, emergencyFlush } from './core/lifecycle.js';
import { captureException } from './capture/captureException.js';
import { captureRequest } from './capture/captureRequest.js';
import { captureMessage } from './capture/captureMessage.js';
import { captureEvent } from './capture/captureEvent.js';
import { captureMetric } from './capture/captureMetric.js';
import { captureLog } from './capture/captureLog.js';
import { startProfile, stopProfile, startHeapProfile, stopHeapProfile } from './capture/captureProfile.js';
import { addBreadcrumb, getTraceId, getSpanId } from './core/context.js';
import { setUser, setTag, setTags, setContext } from './core/scope.js';
import { startSpan, withSpan, withSpanSync, withBackgroundSpan, startBackgroundSpan, trace, wrap, } from './tracing/tracer.js';
import { incrementCounter, setGauge, recordHistogram, addUpDownCounter, } from './capture/captureMetric.js';
import { startDbSpan, withDbSpan, withDbSpanSync } from './tracing/db-span.js';
import { lynktraceMiddleware, lynktraceExpressErrorHandler, expressErrorHandler } from './instrumentation/express.js';
import { lynktraceFastifyPlugin } from './instrumentation/fastify.js';
import { wrapHandler } from './serverless/index.js';
import { registerBootstrapAutoInstrumentations } from './instrumentation/auto-instrument.js';
try {
    registerBootstrapAutoInstrumentations();
}
catch {
    // Safe fail-open: bootstrap auto-instrumentation must never crash host application import (SEC-08)
}
// ─── Lifecycle ──────────────────────────────────────────────────────────────
export { flush, shutdown, emergencyFlush } from './core/lifecycle.js';
export { wrapHandler } from './serverless/index.js';
export { getConfig } from './core/config.js';
export { SDKError } from './core/errors.js';
export { SDK_NAME, SDK_VERSION } from './constants/version.js';
// ─── Capture (the canonical event API) ──────────────────────────────────────
export { captureException } from './capture/captureException.js';
export { captureRequest } from './capture/captureRequest.js';
export { captureMessage } from './capture/captureMessage.js';
export { captureEvent } from './capture/captureEvent.js';
export { captureCronCheckIn } from './capture/captureCronCheckIn.js';
export { captureLog } from './capture/captureLog.js';
export { startProfile, stopProfile, startHeapProfile, stopHeapProfile } from './capture/captureProfile.js';
export { cpuMonitor } from './utils/cpu-monitor.js';
export { StorageDetector } from './utils/storage-detector.js';
export { gpuMonitor } from './utils/gpu-monitor.js';
export { generateId, generateShortId, isValidUUID, isValidUUIDv7, extractTimestampFromUUIDv7 } from './utils/uuid.js';
export { captureMetric, incrementCounter, setGauge, recordHistogram, addUpDownCounter, } from './capture/captureMetric.js';
// ─── Context & breadcrumbs ──────────────────────────────────────────────────
export { addBreadcrumb, getRequestContext, getTraceId, getSpanId, withContext, createContextStore, bindContext } from './core/context.js';
// ─── Scope management ──────────────────────────────────────────────────────
export { setUser, setTag, setTags, removeTag, setExtra, setExtras, removeExtra, setContext, getScopeData, clearScope, withScope, } from './core/scope.js';
// ─── Tracing (manual span APIs) ─────────────────────────────────────────────
export { startSpan, withSpan, withSpanSync, withBackgroundSpan, startBackgroundSpan, trace, wrap, getActiveBackgroundSpanCount, getActiveSpan, flushTracer, } from './tracing/tracer.js';
export { startDbSpan, withDbSpan, withDbSpanSync } from './tracing/db-span.js';
export { extractTraceContext, injectTraceContext } from './tracing/context-propagation.js';
export { LynkTraceSpan } from './tracing/span.js';
// ─── Framework instrumentation ──────────────────────────────────────────────
export { lynktraceMiddleware, lynktraceExpressErrorHandler, expressErrorHandler, instrumentExpress } from './instrumentation/express.js';
export { lynktraceFastifyPlugin } from './instrumentation/fastify.js';
export { registerAutoInstrumentations } from './instrumentation/auto-instrument.js';
export { registerEsmLoaderHooks } from './instrumentation/esm-loader.js';
export { createGraphQLInstrumentation } from './instrumentation/graphql.js';
export { createPrismaInstrumentation, lynktracePrismaExtension, instrumentPrismaClientInstance } from './instrumentation/prisma.js';
export { createMongoDBInstrumentation } from './instrumentation/mongodb.js';
export { createMongooseInstrumentation, MongooseInstrumentation, LynkTraceMongooseInstrumentation } from './instrumentation/mongoose.js';
export { createRedisInstrumentation } from './instrumentation/redis.js';
export { createBullMQInstrumentation } from './instrumentation/bullmq.js';
export { createAxiosInstrumentation } from './instrumentation/axios.js';
export { createPgInstrumentation, patchPgPoolConnectOnce } from './instrumentation/pg.js';
export { createMySQLInstrumentation } from './instrumentation/mysql.js';
export { patchEventEmitter, unpatchEventEmitter } from './instrumentation/event-emitter-patch.js';
export { installHttpLifecycleGuard, uninstallHttpLifecycleGuard, isOtelInstrumentationError } from './instrumentation/http-lifecycle-guard.js';
export { computeExclusiveDuration, SpanDurationTracker, spanDurationTracker } from './tracing/span-duration.js';
export { LynkTraceDrizzleLogger, createDrizzleInstrumentation } from './instrumentation/drizzle.js';
// ─── Logger control (apps wiring SDK into their own logger) ─────────────────
export { setLogger, setDebugMode, setLogLevel } from './utils/logger.js';
export { Severity, severityFromString, isSeverityGte, doesSeverityMeetThreshold } from './types/severity.js';
export { classifyError } from './core/error-classifier.js';
// ─── Health snapshot ────────────────────────────────────────────────────────
import { eventQueue } from './transport/queue.js';
import { TransportRouter } from './transport/transport-router.js';
import { peekSessionManager } from './session/session-manager.js';
import { MemoryPressureMonitor } from './utils/backpressure.js';
import { client } from './core/client.js';
import { errorDeduplicator } from './processors/deduplicator.js';
import { persistentStorage } from './storage/persistent-storage.js';
import { sourceMapResolver } from './processors/source-map-resolver.js';
import { metricsRegistry } from './metrics/registry.js';
import { adaptivePressure } from './utils/adaptive-pressure.js';
import { quotaController } from './core/quota-controller.js';
import { loadShedder } from './transport/load-shedder.js';
let sharedMemoryMonitor = null;
function getSharedMemoryMonitor() {
    if (!sharedMemoryMonitor) {
        sharedMemoryMonitor = new MemoryPressureMonitor();
    }
    return sharedMemoryMonitor;
}
/**
 * Comprehensive SDK health snapshot for operational dashboards. Safe to call
 * at any time — returns degraded info if the SDK is not yet initialized.
 */
export function getHealth() {
    const memState = getSharedMemoryMonitor().getState();
    const sessionMgr = peekSessionManager();
    const sessionHealth = sessionMgr?.getSessionHealth();
    const dedupStats = errorDeduplicator.getStats();
    const persistenceStats = persistentStorage.getStats();
    const sourceMapStats = sourceMapResolver.getStats();
    const metricsStats = metricsRegistry.getStats();
    const transportHealth = TransportRouter.getInstance()?.getHealth();
    const pressureSnapshot = adaptivePressure.getSnapshot();
    const quotaSnapshot = quotaController.getSnapshot();
    const shedderStats = loadShedder.getStats();
    const transportRoutes = transportHealth ? Object.values(transportHealth.routes) : [];
    const routerQueueSize = transportRoutes.reduce((acc, r) => acc + r.queueSize, 0);
    const routerDropped = transportRoutes.reduce((acc, r) => acc + r.totalDropped, 0);
    return {
        initialized: client.initialized,
        circuitState: transportRoutes.length > 0
            ? transportRoutes.map(route => route.circuitState).join(',')
            : 'uninitialized',
        queueSize: eventQueue.size() + routerQueueSize,
        queueDropped: eventQueue.getDroppedCount() + routerDropped,
        queueDeadLetter: eventQueue.getDeadLetterCount(),
        memory: {
            level: memState.level,
            heapUsedMb: Math.round(memState.heapUsedMb * 100) / 100,
            heapUtilization: Math.round(memState.heapUtilization * 1000) / 1000,
            effectiveLimitMb: Math.round(memState.effectiveLimitMb),
            effectiveUtilization: Math.round(memState.effectiveUtilization * 1000) / 1000,
        },
        pressure: {
            state: pressureSnapshot.state,
            score: pressureSnapshot.score,
            level: pressureSnapshot.level,
        },
        quota: {
            state: quotaSnapshot.state,
            isExhausted: quotaSnapshot.isExhausted,
            droppedEventsCount: quotaSnapshot.droppedEventsCount,
            droppedByPriority: quotaSnapshot.droppedByPriority,
        },
        routeCircuits: transportHealth
            ? Object.fromEntries(Object.entries(transportHealth.routes).map(([k, r]) => [k, r.circuitState]))
            : {},
        loadShedder: {
            totalShed: shedderStats.totalShed,
            totalAdmitted: shedderStats.totalAdmitted,
            groupsAdmitted: shedderStats.groupsAdmitted,
            groupsShed: shedderStats.groupsShed,
        },
        session: {
            totalSessions: sessionHealth?.totalSessions ?? 0,
            crashFreeRate: sessionHealth?.crashFreeRate ?? 1.0,
            currentSessionId: sessionHealth?.currentSessionId ?? null,
        },
        pluginCount: client.initialized ? client.plugins.length : 0,
        dedup: {
            trackedErrors: dedupStats.trackedErrors,
            suppressedCount: dedupStats.suppressedCount,
        },
        persistence: {
            initialized: persistenceStats.initialized,
            eventCount: persistenceStats.eventCount,
            fileSizeBytes: persistenceStats.fileSizeBytes,
            totalDiscarded: persistenceStats.totalDiscarded,
            replayCount: persistenceStats.replayCount,
            lastReplayAt: persistenceStats.lastReplayAt,
            totalReplayed: persistenceStats.totalReplayed,
        },
        sourceMaps: {
            cacheSize: sourceMapStats.cacheSize,
            hitRate: sourceMapStats.hitRate,
        },
        metrics: {
            histogramCount: metricsStats.otelStats?.histogramCount ?? 0,
            counterCount: metricsStats.otelStats?.counterCount ?? 0,
            gaugeCount: metricsStats.otelStats?.gaugeCount ?? 0,
            totalFlushed: metricsStats.totalFlushed,
        },
    };
}
/**
 * Canonical LynkTrace SDK facade namespace.
 * Enables both `import { LynkTrace } from '@lynktrace/node'` and `import LynkTrace from '@lynktrace/node'`.
 */
export const LynkTrace = {
    init,
    flush,
    shutdown,
    emergencyFlush,
    wrapHandler,
    captureException,
    captureRequest,
    captureMessage,
    captureEvent,
    captureMetric,
    captureLog,
    incrementCounter,
    setGauge,
    recordHistogram,
    addUpDownCounter,
    startProfile,
    stopProfile,
    startHeapProfile,
    stopHeapProfile,
    addBreadcrumb,
    setUser,
    setTag,
    setTags,
    setContext,
    startSpan,
    withSpan,
    withSpanSync,
    withBackgroundSpan,
    startBackgroundSpan,
    trace,
    wrap,
    startDbSpan,
    withDbSpan,
    withDbSpanSync,
    getTraceId,
    getSpanId,
    getHealth,
    lynktraceMiddleware,
    expressErrorHandler: lynktraceExpressErrorHandler,
    lynktraceExpressErrorHandler,
    lynktraceFastifyPlugin,
};
export default LynkTrace;
