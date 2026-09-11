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
 *     import { createSDK, captureError, monitorMiddleware } from '@vikasbaplawat1/pulse-sdk'
 *
 *     await createSDK({ apiKey: process.env.PULSE_API_KEY! })
 *     app.use(monitorMiddleware())
 */

import { init } from './core/init.js'
import type { SDKInitOptions, RemoteConfigResponse } from './types/config.js'
import { registerBootstrapAutoInstrumentations } from './instrumentation/auto-instrument.js'

registerBootstrapAutoInstrumentations()

// ─── Lifecycle ──────────────────────────────────────────────────────────────

export { init } from './core/init.js'
export { flush, shutdown, crashFlush } from './core/lifecycle.js'
export { getConfig } from './core/config.js'
export { SDKError } from './core/errors.js'
export { SDK_NAME, SDK_VERSION } from './constants/version.js'

/**
 * Create and initialize the SDK. Recommended entry point — equivalent to
 * `init()` with a more discoverable name.
 *
 * @example
 * ```ts
 * const sdk = await createSDK({
 *   apiKey: 'pk_live_...',
 *   applicationName: 'payments-service',
 * })
 * ```
 */
export async function createSDK(options: SDKInitOptions): Promise<Readonly<RemoteConfigResponse> | undefined> {
  return init(options)
}

// ─── Capture (the canonical event API) ──────────────────────────────────────

export { captureError } from './capture/captureError.js'
export { captureRequest } from './capture/captureRequest.js'
export { captureMessage } from './capture/captureMessage.js'
export { captureEvent } from './capture/captureEvent.js'
export { captureCronCheckIn } from './capture/captureCronCheckIn.js'
export type { CronCheckInOptions } from './capture/captureCronCheckIn.js'
export { captureLog } from './capture/captureLog.js'
export type { CaptureLogLevel } from './capture/captureLog.js'
export { captureReplay } from './capture/captureReplay.js'
export { startProfile, stopProfile } from './capture/captureProfile.js'
export {
  captureMetric,
  incrementCounter,
  setGauge,
  recordHistogram,
  addUpDownCounter,
} from './capture/captureMetric.js'
export type { EventReceipt } from './core/event-receipt.js'

// ─── Context & breadcrumbs ──────────────────────────────────────────────────

export { addBreadcrumb, getRequestContext, getTraceId, getSpanId, withContext, createContextStore, bindContext } from './core/context.js'
export type { ContextStore } from './core/context.js'

// ─── Scope management ──────────────────────────────────────────────────────

export {
  setUser,
  setTag,
  setTags,
  removeTag,
  setExtra,
  setExtras,
  removeExtra,
  setContext,
  getScopeData,
  clearScope,
  withScope,
} from './core/scope.js'
export type { User, ScopeData } from './core/scope.js'

// ─── Tracing (manual span APIs) ─────────────────────────────────────────────

export {
  startSpan,
  withSpan,
  withSpanSync,
  withBackgroundSpan,
  startBackgroundSpan,
  getActiveBackgroundSpanCount,
  getActiveSpan,
  flushTracer,
} from './tracing/tracer.js'
export { startDbSpan, withDbSpan, withDbSpanSync } from './tracing/db-span.js'
export { extractTraceContext, injectTraceContext } from './tracing/context-propagation.js'
export type { DbSpanOptions, DbSystem } from './tracing/db-span.js'
export type { SpanStatus, SpanKindName, SpanOptions, SpanLink } from './tracing/span.js'
export type { BackgroundSpanOptions } from './tracing/tracer.js'

// ─── Framework instrumentation ──────────────────────────────────────────────

export { monitorMiddleware, expressErrorHandler } from './instrumentation/express.js'
export type { PulseExpressOptions } from './instrumentation/express.js'
export { fastifyPulsePlugin } from './instrumentation/fastify.js'
export type { PulseFastifyOptions } from './instrumentation/fastify.js'
export { registerAutoInstrumentations } from './instrumentation/auto-instrument.js'
export { registerEsmLoaderHooks } from './instrumentation/esm-loader.js'
export { createGraphQLInstrumentation } from './instrumentation/graphql.js'
export type { GraphQLInstrumentationOptions } from './instrumentation/graphql.js'
export { createPrismaInstrumentation } from './instrumentation/prisma.js'
export type { PrismaInstrumentationOptions } from './instrumentation/prisma.js'
export { createMongoDBInstrumentation } from './instrumentation/mongodb.js'
export type { MongoDBInstrumentationOptions } from './instrumentation/mongodb.js'
export { createRedisInstrumentation } from './instrumentation/redis.js'
export type { RedisInstrumentationOptions } from './instrumentation/redis.js'
export { createBullMQInstrumentation } from './instrumentation/bullmq.js'
export type { BullMQInstrumentationOptions } from './instrumentation/bullmq.js'
export { createAxiosInstrumentation } from './instrumentation/axios.js'
export type { AxiosInstrumentationOptions } from './instrumentation/axios.js'
export { createPgInstrumentation } from './instrumentation/pg.js'
export type { PgInstrumentationOptions } from './instrumentation/pg.js'
export { createMySQLInstrumentation } from './instrumentation/mysql.js'
export type { MySQLInstrumentationOptions } from './instrumentation/mysql.js'
export { patchEventEmitter, unpatchEventEmitter } from './instrumentation/event-emitter-patch.js'
export { installHttpLifecycleGuard, uninstallHttpLifecycleGuard, isOtelInstrumentationError } from './instrumentation/http-lifecycle-guard.js'
export { computeExclusiveDuration, SpanDurationTracker, spanDurationTracker } from './tracing/span-duration.js'
export type { SpanInterval, DurationBreakdown } from './tracing/span-duration.js'

// ─── Logger control (apps wiring SDK into their own logger) ─────────────────

export { setLogger, setDebugMode, setLogLevel } from './utils/logger.js'
export type { Logger, LogFormat } from './utils/logger.js'

// ─── Public types ───────────────────────────────────────────────────────────

export type {
  SDKInitOptions,
  RemoteConfigResponse,
  EntitlementsConfig,
} from './types/config.js'

export type {
  SDKEvent,
  RequestEvent,
  ErrorEvent,
  MessageEvent,
  MetricEvent,
  EventMetadata,
  StackFrame,
  LogEvent,
  ProfileEvent,
  ReplayEvent,
  CronCheckInEvent,
  SpanEvent,
  TraceEvent,
  AggregatedSpanEvent,
} from './types/event.js'

export type { Breadcrumb, BreadcrumbInput, BreadcrumbHint } from './types/breadcrumb.js'
export type { SeverityLevel } from './types/severity.js'
export { Severity, severityFromString } from './types/severity.js'
export type { SDKPlugin, PluginMeta, PluginContext, EventProcessor, BreadcrumbProcessor } from './types/plugin.js'
export type { ErrorSeverity, ErrorMechanism, ErrorClassification, ParsedError, ErrorGrouping } from './types/error.js'
export { classifyError } from './core/error-classifier.js'


// ─── Health snapshot ────────────────────────────────────────────────────────

import { eventQueue } from './transport/queue.js'
import { TransportRouter } from './transport/transport-router.js'
import { getSessionManager } from './session/session-manager.js'
import { MemoryPressureMonitor } from './utils/backpressure.js'
import { client } from './core/client.js'
import { errorDeduplicator } from './processors/deduplicator.js'
import { persistentStorage } from './storage/persistent-storage.js'
import { sourceMapResolver } from './processors/source-map-resolver.js'
import { metricsRegistry } from './metrics/registry.js'

import { adaptivePressure } from './utils/adaptive-pressure.js'
import { quotaController } from './core/quota-controller.js'
import { loadShedder } from './transport/load-shedder.js'

export type {
  TelemetryPriority,
  PressureState,
  QuotaState,
  DegradationInfo,
  CorrelationGroupInfo,
  OperationalMetricsSnapshot,
} from './types/telemetry-classes.js'

let sharedMemoryMonitor: MemoryPressureMonitor | null = null
function getSharedMemoryMonitor(): MemoryPressureMonitor {
  if (!sharedMemoryMonitor) {
    sharedMemoryMonitor = new MemoryPressureMonitor()
  }
  return sharedMemoryMonitor
}

/**
 * Comprehensive SDK health snapshot for operational dashboards. Safe to call
 * at any time — returns degraded info if the SDK is not yet initialized.
 */
export function getSDKHealth(): {
  initialized: boolean
  circuitState: string
  queueSize: number
  queueDropped: number
  queueDeadLetter: number
  memory: { level: string; heapUsedMb: number; heapUtilization: number; effectiveLimitMb: number; effectiveUtilization: number }
  pressure: { state: string; score: number; level: string }
  quota: { state: string; isExhausted: boolean; droppedEventsCount: number }
  loadShedder: { totalShed: number; totalAdmitted: number; groupsAdmitted: number; groupsShed: number }
  session: { totalSessions: number; crashFreeRate: number; currentSessionId: string | null }
  pluginCount: number
  dedup: { trackedErrors: number; suppressedCount: number }
  persistence: {
    initialized: boolean
    eventCount: number
    fileSizeBytes: number
    /** Events confirmed delivered and removed from disk. */
    totalDiscarded: number
    /** Number of replay() runs since this process started. */
    replayCount: number
    /** Epoch ms of the most recent replay completion (0 if never replayed). */
    lastReplayAt: number
    /** Events surfaced by the most recent replay (undelivered from prior session). */
    totalReplayed: number
  }
  sourceMaps: { cacheSize: number; hitRate: number }
  metrics: { histogramCount: number; counterCount: number; gaugeCount: number; totalFlushed: number }
} {
  const memState = getSharedMemoryMonitor().getState()
  const sessionMgr = getSessionManager()
  const sessionHealth = sessionMgr.getSessionHealth()
  const dedupStats = errorDeduplicator.getStats()
  const persistenceStats = persistentStorage.getStats()
  const sourceMapStats = sourceMapResolver.getStats()
  const metricsStats = metricsRegistry.getStats()
  const transportHealth = TransportRouter.getInstance()?.getHealth()
  const pressureSnapshot = adaptivePressure.getSnapshot()
  const quotaSnapshot = quotaController.getSnapshot()
  const shedderStats = loadShedder.getStats()

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
  }
}
