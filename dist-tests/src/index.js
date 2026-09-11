/**
 * @vikasbaplawat1/pulse-sdk — Enterprise observability SDK for Node.js.
 *
 * This file is the public API contract. Every symbol exported here is part
 * of the supported surface and follows semver.
 *
 * Internal engines (ConfigManager, KillswitchEngine, FeatureController,
 * SamplingEngine, LimitsEngine, SecurityScrubber, TransportRouter, etc.)
 * are deliberately NOT exported from this module. They are available via
 * the explicit, no-stability-guarantee sub-path:
 *
 *     import { KillswitchEngine } from '@vikasbaplawat1/pulse-sdk/internals'
 *
 * Typical usage:
 *
 *     import { init, captureError, monitorMiddleware } from '@pulse-apm/node'
 *
 *     await init({ apiKey: process.env.PULSE_API_KEY! })
 *     app.use(monitorMiddleware())
 */
export { init } from './core/init.js';
import { registerBootstrapAutoInstrumentations } from './instrumentation/auto-instrument.js';
registerBootstrapAutoInstrumentations();
// ─── Lifecycle ──────────────────────────────────────────────────────────────
export { flush, shutdown, crashFlush } from './core/lifecycle.js';
export { getConfig } from './core/config.js';
export { SDKError } from './core/errors.js';
export { SDK_NAME, SDK_VERSION } from './constants/version.js';
// ─── Capture (the canonical event API) ──────────────────────────────────────
export { captureError } from './capture/captureError.js';
export { captureRequest } from './capture/captureRequest.js';
export { captureMessage } from './capture/captureMessage.js';
export { captureEvent } from './capture/captureEvent.js';
export { captureCronCheckIn } from './capture/captureCronCheckIn.js';
export { captureLog } from './capture/captureLog.js';
export { captureReplay } from './capture/captureReplay.js';
export { startProfile, stopProfile } from './capture/captureProfile.js';
export { captureMetric, incrementCounter, setGauge, recordHistogram, addUpDownCounter, } from './capture/captureMetric.js';
// ─── Context & breadcrumbs ──────────────────────────────────────────────────
export { addBreadcrumb, getRequestContext, getTraceId, getSpanId, withContext, createContextStore, bindContext } from './core/context.js';
// ─── Scope management ──────────────────────────────────────────────────────
export { setUser, setTag, setTags, removeTag, setExtra, setExtras, removeExtra, setContext, getScopeData, clearScope, withScope, } from './core/scope.js';
// ─── Tracing (manual span APIs) ─────────────────────────────────────────────
export { startSpan, withSpan, withSpanSync, withBackgroundSpan, startBackgroundSpan, getActiveBackgroundSpanCount, getActiveSpan, flushTracer, } from './tracing/tracer.js';
export { startDbSpan, withDbSpan, withDbSpanSync } from './tracing/db-span.js';
export { extractTraceContext, injectTraceContext } from './tracing/context-propagation.js';
// ─── Framework instrumentation ──────────────────────────────────────────────
export { monitorMiddleware, expressErrorHandler } from './instrumentation/express.js';
export { fastifyPulsePlugin } from './instrumentation/fastify.js';
export { registerAutoInstrumentations } from './instrumentation/auto-instrument.js';
export { registerEsmLoaderHooks } from './instrumentation/esm-loader.js';
export { createGraphQLInstrumentation } from './instrumentation/graphql.js';
export { createPrismaInstrumentation } from './instrumentation/prisma.js';
export { createMongoDBInstrumentation } from './instrumentation/mongodb.js';
export { createRedisInstrumentation } from './instrumentation/redis.js';
export { createBullMQInstrumentation } from './instrumentation/bullmq.js';
export { createAxiosInstrumentation } from './instrumentation/axios.js';
export { createPgInstrumentation } from './instrumentation/pg.js';
export { createMySQLInstrumentation } from './instrumentation/mysql.js';
export { patchEventEmitter, unpatchEventEmitter } from './instrumentation/event-emitter-patch.js';
export { installHttpLifecycleGuard, uninstallHttpLifecycleGuard, isOtelInstrumentationError } from './instrumentation/http-lifecycle-guard.js';
export { computeExclusiveDuration, SpanDurationTracker, spanDurationTracker } from './tracing/span-duration.js';
// ─── Logger control (apps wiring SDK into their own logger) ─────────────────
export { setLogger, setDebugMode, setLogLevel } from './utils/logger.js';
export { Severity, severityFromString } from './types/severity.js';
export { classifyError } from './core/error-classifier.js';
// ─── Health snapshot ────────────────────────────────────────────────────────
import { eventQueue } from './transport/queue.js';
import { TransportRouter } from './transport/transport-router.js';
import { getSessionManager } from './session/session-manager.js';
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
export function getSDKHealth() {
    const memState = getSharedMemoryMonitor().getState();
    const sessionMgr = getSessionManager();
    const sessionHealth = sessionMgr.getSessionHealth();
    const dedupStats = errorDeduplicator.getStats();
    const persistenceStats = persistentStorage.getStats();
    const sourceMapStats = sourceMapResolver.getStats();
    const metricsStats = metricsRegistry.getStats();
    const transportHealth = TransportRouter.getInstance()?.getHealth();
    const pressureSnapshot = adaptivePressure.getSnapshot();
    const quotaSnapshot = quotaController.getSnapshot();
    const shedderStats = loadShedder.getStats();
    return {
        initialized: client.initialized,
        circuitState: transportHealth
            ? Object.values(transportHealth.routes).map(route => route.circuitState).join(',')
            : 'uninitialized',
        queueSize: eventQueue.size(),
        queueDropped: eventQueue.getDroppedCount(),
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
        },
        loadShedder: {
            totalShed: shedderStats.totalShed,
            totalAdmitted: shedderStats.totalAdmitted,
            groupsAdmitted: shedderStats.groupsAdmitted,
            groupsShed: shedderStats.groupsShed,
        },
        session: {
            totalSessions: sessionHealth.totalSessions,
            crashFreeRate: sessionHealth.crashFreeRate,
            currentSessionId: sessionHealth.currentSessionId,
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
