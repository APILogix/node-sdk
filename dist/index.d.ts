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
import { startSpan, withSpan, withSpanSync, withBackgroundSpan, startBackgroundSpan, trace, wrap } from './tracing/tracer.js';
import { incrementCounter, setGauge, recordHistogram, addUpDownCounter } from './capture/captureMetric.js';
import { startDbSpan, withDbSpan, withDbSpanSync } from './tracing/db-span.js';
import { lynktraceMiddleware, expressErrorHandler } from './instrumentation/express.js';
import { lynktraceFastifyPlugin } from './instrumentation/fastify.js';
import { wrapHandler } from './serverless/index.js';
export { flush, shutdown, emergencyFlush } from './core/lifecycle.js';
export { wrapHandler } from './serverless/index.js';
export type { ServerlessHandler, ServerlessHandlerOptions } from './serverless/index.js';
export { getConfig } from './core/config.js';
export { SDKError } from './core/errors.js';
export { SDK_NAME, SDK_VERSION } from './constants/version.js';
export { captureException } from './capture/captureException.js';
export { captureRequest } from './capture/captureRequest.js';
export { captureMessage } from './capture/captureMessage.js';
export { captureEvent } from './capture/captureEvent.js';
export { captureCronCheckIn } from './capture/captureCronCheckIn.js';
export type { CronCheckInOptions } from './capture/captureCronCheckIn.js';
export { captureLog } from './capture/captureLog.js';
export type { CaptureLogLevel } from './capture/captureLog.js';
export { startProfile, stopProfile, startHeapProfile, stopHeapProfile } from './capture/captureProfile.js';
export { cpuMonitor } from './utils/cpu-monitor.js';
export { StorageDetector } from './utils/storage-detector.js';
export { gpuMonitor } from './utils/gpu-monitor.js';
export { generateId, generateShortId, isValidUUID, isValidUUIDv7, extractTimestampFromUUIDv7 } from './utils/uuid.js';
export { captureMetric, incrementCounter, setGauge, recordHistogram, addUpDownCounter, } from './capture/captureMetric.js';
export type { EventReceipt } from './core/event-receipt.js';
export { addBreadcrumb, getRequestContext, getTraceId, getSpanId, withContext, createContextStore, bindContext } from './core/context.js';
export type { ContextStore } from './core/context.js';
export { setUser, setTag, setTags, removeTag, setExtra, setExtras, removeExtra, setContext, getScopeData, clearScope, withScope, } from './core/scope.js';
export type { User, ScopeData } from './core/scope.js';
export { startSpan, withSpan, withSpanSync, withBackgroundSpan, startBackgroundSpan, trace, wrap, getActiveBackgroundSpanCount, getActiveSpan, flushTracer, } from './tracing/tracer.js';
export { startDbSpan, withDbSpan, withDbSpanSync } from './tracing/db-span.js';
export { extractTraceContext, injectTraceContext } from './tracing/context-propagation.js';
export type { DbSpanOptions, DbSystem } from './tracing/db-span.js';
export { LynkTraceSpan, PulseSpan } from './tracing/span.js';
export type { SpanStatus, SpanKindName, SpanOptions, SpanLink } from './tracing/span.js';
export type { BackgroundSpanOptions } from './tracing/tracer.js';
export { lynktraceMiddleware, pulseMiddleware, lynktraceExpressErrorHandler, expressErrorHandler, instrumentExpress } from './instrumentation/express.js';
export type { LynkTraceExpressOptions, PulseExpressOptions } from './instrumentation/express.js';
export { lynktraceFastifyPlugin, pulseFastifyPlugin } from './instrumentation/fastify.js';
export type { LynkTraceFastifyOptions, PulseFastifyOptions } from './instrumentation/fastify.js';
export { registerAutoInstrumentations } from './instrumentation/auto-instrument.js';
export { registerEsmLoaderHooks } from './instrumentation/esm-loader.js';
export { createGraphQLInstrumentation } from './instrumentation/graphql.js';
export type { GraphQLInstrumentationOptions } from './instrumentation/graphql.js';
export { createPrismaInstrumentation, lynktracePrismaExtension, pulsePrismaExtension, instrumentPrismaClientInstance } from './instrumentation/prisma.js';
export type { PrismaInstrumentationOptions } from './instrumentation/prisma.js';
export { createMongoDBInstrumentation } from './instrumentation/mongodb.js';
export type { MongoDBInstrumentationOptions } from './instrumentation/mongodb.js';
export { createMongooseInstrumentation, MongooseInstrumentation, LynkTraceMongooseInstrumentation } from './instrumentation/mongoose.js';
export type { MongooseInstrumentationOptions } from './instrumentation/mongoose.js';
export { createRedisInstrumentation } from './instrumentation/redis.js';
export type { RedisInstrumentationOptions } from './instrumentation/redis.js';
export { createBullMQInstrumentation } from './instrumentation/bullmq.js';
export type { BullMQInstrumentationOptions } from './instrumentation/bullmq.js';
export { createAxiosInstrumentation } from './instrumentation/axios.js';
export type { AxiosInstrumentationOptions } from './instrumentation/axios.js';
export { createPgInstrumentation, patchPgPoolConnectOnce } from './instrumentation/pg.js';
export type { PgInstrumentationOptions } from './instrumentation/pg.js';
export { createMySQLInstrumentation } from './instrumentation/mysql.js';
export type { MySQLInstrumentationOptions } from './instrumentation/mysql.js';
export { patchEventEmitter, unpatchEventEmitter } from './instrumentation/event-emitter-patch.js';
export { installHttpLifecycleGuard, uninstallHttpLifecycleGuard, isOtelInstrumentationError } from './instrumentation/http-lifecycle-guard.js';
export { computeExclusiveDuration, SpanDurationTracker, spanDurationTracker } from './tracing/span-duration.js';
export type { SpanInterval, DurationBreakdown } from './tracing/span-duration.js';
export { LynkTraceDrizzleLogger, PulseDrizzleLogger, createDrizzleInstrumentation } from './instrumentation/drizzle.js';
export type { DrizzleInstrumentationOptions } from './instrumentation/drizzle.js';
export { setLogger, setDebugMode, setLogLevel } from './utils/logger.js';
export type { Logger, LogFormat } from './utils/logger.js';
export type { SDKInitOptions, RemoteConfigResponse, EntitlementsConfig, OfflineQueueConfig, OfflineQueueInitOptions, } from './types/config.js';
export type { SDKEvent, RequestEvent, ErrorEvent, MessageEvent, MetricEvent, EventMetadata, StackFrame, LogEvent, ProfileEvent, CronCheckInEvent, SpanEvent, TraceEvent, AggregatedSpanEvent, } from './types/event.js';
export type { Breadcrumb, BreadcrumbInput, BreadcrumbHint } from './types/breadcrumb.js';
export type { SeverityLevel } from './types/severity.js';
export { Severity, severityFromString, isSeverityGte, doesSeverityMeetThreshold } from './types/severity.js';
export type { SDKPlugin, PluginMeta, PluginContext, EventProcessor, BreadcrumbProcessor } from './types/plugin.js';
export type { ErrorSeverity, ErrorMechanism, ErrorClassification, ParsedError, ErrorGrouping } from './types/error.js';
export { classifyError } from './core/error-classifier.js';
export type { TelemetryPriority, PressureState, QuotaState, DegradationInfo, CorrelationGroupInfo, OperationalMetricsSnapshot, } from './types/telemetry-classes.js';
/**
 * Comprehensive SDK health snapshot for operational dashboards. Safe to call
 * at any time — returns degraded info if the SDK is not yet initialized.
 */
export declare function getHealth(): {
    initialized: boolean;
    circuitState: string;
    queueSize: number;
    queueDropped: number;
    queueDeadLetter: number;
    memory: {
        level: string;
        heapUsedMb: number;
        heapUtilization: number;
        effectiveLimitMb: number;
        effectiveUtilization: number;
    };
    pressure: {
        state: string;
        score: number;
        level: string;
    };
    quota: {
        state: string;
        isExhausted: boolean;
        droppedEventsCount: number;
        droppedByPriority?: Record<string, number>;
    };
    routeCircuits?: Record<string, string>;
    loadShedder: {
        totalShed: number;
        totalAdmitted: number;
        groupsAdmitted: number;
        groupsShed: number;
    };
    session: {
        totalSessions: number;
        crashFreeRate: number;
        currentSessionId: string | null;
    };
    pluginCount: number;
    dedup: {
        trackedErrors: number;
        suppressedCount: number;
    };
    persistence: {
        initialized: boolean;
        eventCount: number;
        fileSizeBytes: number;
        /** Events confirmed delivered and removed from disk. */
        totalDiscarded: number;
        /** Number of replay() runs since this process started. */
        replayCount: number;
        /** Epoch ms of the most recent replay completion (0 if never replayed). */
        lastReplayAt: number;
        /** Events surfaced by the most recent replay (undelivered from prior session). */
        totalReplayed: number;
    };
    sourceMaps: {
        cacheSize: number;
        hitRate: number;
    };
    metrics: {
        histogramCount: number;
        counterCount: number;
        gaugeCount: number;
        totalFlushed: number;
    };
};
/**
 * Canonical LynkTrace SDK facade namespace.
 * Enables both `import { LynkTrace } from '@lynktrace/node'` and `import LynkTrace from '@lynktrace/node'`.
 */
export declare const LynkTrace: {
    init: typeof init;
    flush: typeof flush;
    shutdown: typeof shutdown;
    emergencyFlush: typeof emergencyFlush;
    wrapHandler: typeof wrapHandler;
    captureException: typeof captureException;
    captureRequest: typeof captureRequest;
    captureMessage: typeof captureMessage;
    captureEvent: typeof captureEvent;
    captureMetric: typeof captureMetric;
    captureLog: typeof captureLog;
    incrementCounter: typeof incrementCounter;
    setGauge: typeof setGauge;
    recordHistogram: typeof recordHistogram;
    addUpDownCounter: typeof addUpDownCounter;
    startProfile: typeof startProfile;
    stopProfile: typeof stopProfile;
    startHeapProfile: typeof startHeapProfile;
    stopHeapProfile: typeof stopHeapProfile;
    addBreadcrumb: typeof addBreadcrumb;
    setUser: typeof setUser;
    setTag: typeof setTag;
    setTags: typeof setTags;
    setContext: typeof setContext;
    startSpan: typeof startSpan;
    withSpan: typeof withSpan;
    withSpanSync: typeof withSpanSync;
    withBackgroundSpan: typeof withBackgroundSpan;
    startBackgroundSpan: typeof startBackgroundSpan;
    trace: typeof trace;
    wrap: typeof wrap;
    startDbSpan: typeof startDbSpan;
    withDbSpan: typeof withDbSpan;
    withDbSpanSync: typeof withDbSpanSync;
    getTraceId: typeof getTraceId;
    getSpanId: typeof getSpanId;
    getHealth: typeof getHealth;
    lynktraceMiddleware: typeof lynktraceMiddleware;
    pulseMiddleware: typeof lynktraceMiddleware;
    expressErrorHandler: typeof expressErrorHandler;
    lynktraceExpressErrorHandler: typeof expressErrorHandler;
    lynktraceFastifyPlugin: typeof lynktraceFastifyPlugin;
    pulseFastifyPlugin: typeof lynktraceFastifyPlugin;
};
/**
 * Backward compatibility alias for the LynkTrace facade namespace.
 */
export declare const Pulse: {
    init: typeof init;
    flush: typeof flush;
    shutdown: typeof shutdown;
    emergencyFlush: typeof emergencyFlush;
    wrapHandler: typeof wrapHandler;
    captureException: typeof captureException;
    captureRequest: typeof captureRequest;
    captureMessage: typeof captureMessage;
    captureEvent: typeof captureEvent;
    captureMetric: typeof captureMetric;
    captureLog: typeof captureLog;
    incrementCounter: typeof incrementCounter;
    setGauge: typeof setGauge;
    recordHistogram: typeof recordHistogram;
    addUpDownCounter: typeof addUpDownCounter;
    startProfile: typeof startProfile;
    stopProfile: typeof stopProfile;
    startHeapProfile: typeof startHeapProfile;
    stopHeapProfile: typeof stopHeapProfile;
    addBreadcrumb: typeof addBreadcrumb;
    setUser: typeof setUser;
    setTag: typeof setTag;
    setTags: typeof setTags;
    setContext: typeof setContext;
    startSpan: typeof startSpan;
    withSpan: typeof withSpan;
    withSpanSync: typeof withSpanSync;
    withBackgroundSpan: typeof withBackgroundSpan;
    startBackgroundSpan: typeof startBackgroundSpan;
    trace: typeof trace;
    wrap: typeof wrap;
    startDbSpan: typeof startDbSpan;
    withDbSpan: typeof withDbSpan;
    withDbSpanSync: typeof withDbSpanSync;
    getTraceId: typeof getTraceId;
    getSpanId: typeof getSpanId;
    getHealth: typeof getHealth;
    lynktraceMiddleware: typeof lynktraceMiddleware;
    pulseMiddleware: typeof lynktraceMiddleware;
    expressErrorHandler: typeof expressErrorHandler;
    lynktraceExpressErrorHandler: typeof expressErrorHandler;
    lynktraceFastifyPlugin: typeof lynktraceFastifyPlugin;
    pulseFastifyPlugin: typeof lynktraceFastifyPlugin;
};
export default LynkTrace;
