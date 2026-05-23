/**
 * @vikasbaplawat1/pulse-sdk — Enterprise Observability SDK
 *
 * Public API surface. Every export here is part of the SDK contract.
 *
 * Usage:
 *   import { createSDK, captureError, captureMessage } from '@vikasbaplawat1/pulse-sdk'
 *
 *   const sdk = await createSDK({
 *     apiKey: process.env.PULSE_API_KEY,
 *     service: 'payments-service',
 *     environment: 'production',
 *     debug: true,
 *   })
 */
// ─── Core ───────────────────────────────────────────────────────────────────
export { init } from './core/init.js';
export { flush, shutdown } from './core/lifecycle.js';
export { getConfig } from './core/config.js';
export { SDKError } from './core/errors.js';
export { client } from './core/client.js';
// ─── Ergonomic Entry Point ──────────────────────────────────────────────────
import { init } from './core/init.js';
/**
 * Create and initialize the SDK — the recommended entry point.
 * Alias for `init()` with a more intuitive name.
 *
 * @example
 * ```ts
 * const sdk = await createSDK({
 *   apiKey: 'pk_live_...',
 *   service: 'payments-service',
 *   environment: 'production',
 *   debug: true,
 *   plugins: [myPlugin()],
 * })
 * ```
 */
export async function createSDK(options) {
    return init(options);
}
// ─── Capture ────────────────────────────────────────────────────────────────
export { captureError } from './capture/captureError.js';
export { captureRequest } from './capture/captureRequest.js';
export { captureMessage } from './capture/captureMessage.js';
export { captureEvent } from './capture/captureEvent.js';
export { captureMetric, incrementCounter, setGauge, recordHistogram, addUpDownCounter } from './capture/captureMetric.js';
// ─── Pipeline Acknowledgment ────────────────────────────────────────────────
export { enqueueEvent } from './core/event-pipeline.js';
// ─── Context ────────────────────────────────────────────────────────────────
export { addBreadcrumb, getRequestContext, getTraceId, getSpanId } from './core/context.js';
// ─── Scope Management ───────────────────────────────────────────────────────
export { setUser, setTag, setTags, removeTag, setExtra, setExtras, removeExtra, setContext, getScopeData, clearScope, withScope, } from './core/scope.js';
// ─── Tracing ────────────────────────────────────────────────────────────────
export { startSpan, withSpan, withSpanSync, getActiveSpan, flushTracer } from './tracing/tracer.js';
export { extractTraceContext, injectTraceContext } from './tracing/context-propagation.js';
export { PulseSpan } from './tracing/span.js';
// ─── Session ────────────────────────────────────────────────────────────────
export { getSessionManager } from './session/session-manager.js';
// ─── Instrumentation ────────────────────────────────────────────────────────
export { monitorMiddleware } from './instrumentation/express.js';
export { instrumentHttpClient } from './instrumentation/http.js';
export { registerAutoInstrumentations } from './instrumentation/auto-instrument.js';
export { createGraphQLInstrumentation } from './instrumentation/graphql.js';
export { createPrismaInstrumentation } from './instrumentation/prisma.js';
export { createMongoDBInstrumentation } from './instrumentation/mongodb.js';
export { createRedisInstrumentation } from './instrumentation/redis.js';
export { createBullMQInstrumentation } from './instrumentation/bullmq.js';
export { createAxiosInstrumentation } from './instrumentation/axios.js';
export { setLogger, getLogger, setDebugMode, setLogLevel, setLogFormat, getLogFormat, jsonLogger } from './utils/logger.js';
export { Severity, severityFromString } from './types/severity.js';
// ─── Remote Config Engine ───────────────────────────────────────────────────
export { ConfigManager } from './core/config-manager.js';
export { KillswitchEngine } from './core/killswitch-engine.js';
export { FeatureController } from './core/feature-controller.js';
export { SamplingEngine } from './core/sampling-engine.js';
export { LimitsEngine } from './core/limits-engine.js';
export { VersionPolicy } from './core/version-policy.js';
export { diffConfigs } from './core/config-differ.js';
export { SecurityScrubber } from './processors/security-scrubber.js';
export { TransportRouter } from './transport/transport-router.js';
export { RouteTransportManager } from './transport/route-transport-manager.js';
// ─── Subsystems ─────────────────────────────────────────────────────────────
export { LoggingSubsystem } from './subsystems/logging-subsystem.js';
export { ProfilingSubsystem } from './subsystems/profiling-subsystem.js';
export { CronSubsystem } from './subsystems/cron-subsystem.js';
// ─── Plan Gating ────────────────────────────────────────────────────────────
export { getPlanDefaults, isFeatureAllowed } from './core/plan-gate.js';
// ─── Event Loop Monitoring ──────────────────────────────────────────────────────
export { EventLoopLagMonitor } from './utils/event-loop-lag.js';
// ─── Resource Detection ───────────────────────────────────────────────────────
export { detectResources, detectOtelResource } from './utils/resource-detector.js';
// ─── Transport Internals (advanced) ──────────────────────────────────────────
export { RetryBudget, globalRetryBudget } from './transport/retry.js';
// ─── Advanced Diagnostics ───────────────────────────────────────────────────
export { otelMetrics } from './metrics/otel-adapter.js';
// ─── Auto Instrumentation ───────────────────────────────────────────────────
// ─── Advanced Diagnostics ───────────────────────────────────────────────────
export { errorDeduplicator } from './processors/deduplicator.js';
export { persistentStorage } from './storage/persistent-storage.js';
export { sourceMapResolver } from './processors/source-map-resolver.js';
export { metricsRegistry } from './metrics/registry.js';
export { slowRequestDetector } from './processors/slow-request-detector.js';
export { persistenceGovernor } from './storage/persistence-governor.js';
// ─── Diagnostics ────────────────────────────────────────────────────────────
import { getCircuitState } from './transport/batcher.js';
import { eventQueue } from './transport/queue.js';
import { getSessionManager } from './session/session-manager.js';
import { MemoryPressureMonitor } from './utils/backpressure.js';
import { client } from './core/client.js';
import { errorDeduplicator } from './processors/deduplicator.js';
import { persistentStorage } from './storage/persistent-storage.js';
import { sourceMapResolver } from './processors/source-map-resolver.js';
import { metricsRegistry } from './metrics/registry.js';
import { slowRequestDetector } from './processors/slow-request-detector.js';
// ─── Shared Singleton ───────────────────────────────────────────────────────
let sharedMemoryMonitor = null;
function getSharedMemoryMonitor() {
    if (!sharedMemoryMonitor) {
        sharedMemoryMonitor = new MemoryPressureMonitor();
    }
    return sharedMemoryMonitor;
}
/**
 * Get a comprehensive SDK health snapshot for operational dashboards.
 * Safe to call at any time — returns degraded info if SDK isn't initialized.
 */
export function getSDKHealth() {
    const memState = getSharedMemoryMonitor().getState();
    const sessionMgr = getSessionManager();
    const sessionHealth = sessionMgr.getSessionHealth();
    const dedupStats = errorDeduplicator.getStats();
    const persistenceStats = persistentStorage.getStats();
    const sourceMapStats = sourceMapResolver.getStats();
    const metricsStats = metricsRegistry.getStats();
    const slowReqStats = slowRequestDetector.getStats();
    return {
        initialized: client.initialized,
        circuitState: getCircuitState(),
        queueSize: eventQueue.size(),
        queueDropped: eventQueue.getDroppedCount(),
        queueDeadLetter: eventQueue.getDeadLetterCount(),
        memory: {
            level: memState.level,
            heapUsedMb: Math.round(memState.heapUsedMb * 100) / 100,
            heapUtilization: Math.round(memState.heapUtilization * 1000) / 1000,
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
        slowRequests: {
            totalChecked: slowReqStats.totalChecked,
            totalSlow: slowReqStats.totalSlow,
            slowRate: slowReqStats.slowRate,
            trackedRoutes: slowReqStats.trackedRoutes,
        },
    };
}
//# sourceMappingURL=index.js.map