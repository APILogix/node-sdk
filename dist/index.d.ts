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
 *     await createSDK({ apiKey: process.env.PULSE_API_KEY!, service: 'payments' })
 *     app.use(monitorMiddleware())
 */
import type { SDKInitOptions, RemoteConfig } from './types/config.js';
export { init } from './core/init.js';
export { flush, shutdown } from './core/lifecycle.js';
export { getConfig } from './core/config.js';
export { SDKError } from './core/errors.js';
/**
 * Create and initialize the SDK. Recommended entry point — equivalent to
 * `init()` with a more discoverable name.
 *
 * @example
 * ```ts
 * const sdk = await createSDK({
 *   apiKey: 'pk_live_...',
 *   service: 'payments-service',
 *   environment: 'production',
 *   plugins: [myPlugin()],
 * })
 * ```
 */
export declare function createSDK(options: SDKInitOptions): Promise<Readonly<RemoteConfig> | undefined>;
export { captureError } from './capture/captureError.js';
export { captureRequest } from './capture/captureRequest.js';
export { captureMessage } from './capture/captureMessage.js';
export { captureEvent } from './capture/captureEvent.js';
export { captureMetric, incrementCounter, setGauge, recordHistogram, addUpDownCounter, } from './capture/captureMetric.js';
export type { EventReceipt } from './core/event-receipt.js';
export { addBreadcrumb, getRequestContext, getTraceId, getSpanId } from './core/context.js';
export { setUser, setTag, setTags, removeTag, setExtra, setExtras, removeExtra, setContext, getScopeData, clearScope, withScope, } from './core/scope.js';
export type { User, ScopeData } from './core/scope.js';
export { startSpan, withSpan, withSpanSync, getActiveSpan, flushTracer } from './tracing/tracer.js';
export { extractTraceContext, injectTraceContext } from './tracing/context-propagation.js';
export type { SpanStatus, SpanOptions, SpanLink } from './tracing/span.js';
export { monitorMiddleware } from './instrumentation/express.js';
export type { PulseExpressOptions } from './instrumentation/express.js';
export { fastifyPulsePlugin } from './instrumentation/fastify.js';
export type { PulseFastifyOptions } from './instrumentation/fastify.js';
export { registerAutoInstrumentations } from './instrumentation/auto-instrument.js';
export type { AutoInstrumentOptions } from './instrumentation/auto-instrument.js';
export { createGraphQLInstrumentation } from './instrumentation/graphql.js';
export type { GraphQLInstrumentationOptions } from './instrumentation/graphql.js';
export { createPrismaInstrumentation } from './instrumentation/prisma.js';
export type { PrismaInstrumentationOptions } from './instrumentation/prisma.js';
export { createMongoDBInstrumentation } from './instrumentation/mongodb.js';
export type { MongoDBInstrumentationOptions } from './instrumentation/mongodb.js';
export { createRedisInstrumentation } from './instrumentation/redis.js';
export type { RedisInstrumentationOptions } from './instrumentation/redis.js';
export { createBullMQInstrumentation } from './instrumentation/bullmq.js';
export type { BullMQInstrumentationOptions } from './instrumentation/bullmq.js';
export { createAxiosInstrumentation } from './instrumentation/axios.js';
export type { AxiosInstrumentationOptions } from './instrumentation/axios.js';
export { setLogger, setDebugMode, setLogLevel } from './utils/logger.js';
export type { Logger, LogFormat } from './utils/logger.js';
export type { SDKInitOptions, RemoteConfig, ResolvedSDKConfig, TransportOptions, PlanTier, PlanFeatures, } from './types/config.js';
export type { SDKEvent, RequestEvent, ErrorEvent, MessageEvent, MetricEvent, EventMetadata, StackFrame, LogEvent, ProfileEvent, ReplayEvent, CronCheckInEvent, SpanEvent, } from './types/event.js';
export type { Breadcrumb, BreadcrumbInput, BreadcrumbHint } from './types/breadcrumb.js';
export type { SeverityLevel } from './types/severity.js';
export { Severity, severityFromString } from './types/severity.js';
export type { SDKPlugin, PluginMeta, PluginContext, EventProcessor, BreadcrumbProcessor } from './types/plugin.js';
export type { CaptureErrorOptions, ParsedError, ErrorGrouping } from './types/error.js';
/**
 * Comprehensive SDK health snapshot for operational dashboards. Safe to call
 * at any time — returns degraded info if the SDK is not yet initialized.
 */
export declare function getSDKHealth(): {
    initialized: boolean;
    circuitState: string;
    queueSize: number;
    queueDropped: number;
    queueDeadLetter: number;
    memory: {
        level: string;
        heapUsedMb: number;
        heapUtilization: number;
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
//# sourceMappingURL=index.d.ts.map