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
export { init } from './core/init.js';
export { flush, shutdown } from './core/lifecycle.js';
export { getConfig } from './core/config.js';
export { SDKError } from './core/errors.js';
export { client } from './core/client.js';
import type { SDKInitOptions, RemoteConfig } from './types/config.js';
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
export declare function createSDK(options: SDKInitOptions): Promise<Readonly<RemoteConfig> | undefined>;
export { captureError } from './capture/captureError.js';
export { captureRequest } from './capture/captureRequest.js';
export { captureMessage } from './capture/captureMessage.js';
export { captureEvent } from './capture/captureEvent.js';
export { captureMetric, incrementCounter, setGauge, recordHistogram, addUpDownCounter } from './capture/captureMetric.js';
export { enqueueEvent } from './core/event-pipeline.js';
export type { EventReceipt } from './core/event-receipt.js';
export { addBreadcrumb, getRequestContext, getTraceId, getSpanId } from './core/context.js';
export { setUser, setTag, setTags, removeTag, setExtra, setExtras, removeExtra, setContext, getScopeData, clearScope, withScope, } from './core/scope.js';
export type { User, ScopeData } from './core/scope.js';
export { startSpan, withSpan, withSpanSync, getActiveSpan, flushTracer } from './tracing/tracer.js';
export { extractTraceContext, injectTraceContext } from './tracing/context-propagation.js';
export type { SpanStatus, SpanOptions, SpanLink } from './tracing/span.js';
export { PulseSpan } from './tracing/span.js';
export { getSessionManager } from './session/session-manager.js';
export type { Session, SessionManagerOptions } from './session/session-manager.js';
export { monitorMiddleware } from './instrumentation/express.js';
export { instrumentHttpClient } from './instrumentation/http.js';
export { registerAutoInstrumentations } from './instrumentation/auto-instrument.js';
export { createGraphQLInstrumentation } from './instrumentation/graphql.js';
export { createPrismaInstrumentation } from './instrumentation/prisma.js';
export { createMongoDBInstrumentation } from './instrumentation/mongodb.js';
export { createRedisInstrumentation } from './instrumentation/redis.js';
export { createBullMQInstrumentation } from './instrumentation/bullmq.js';
export { createAxiosInstrumentation } from './instrumentation/axios.js';
export type { AutoInstrumentOptions } from './instrumentation/auto-instrument.js';
export type { GraphQLInstrumentationOptions } from './instrumentation/graphql.js';
export type { PrismaInstrumentationOptions } from './instrumentation/prisma.js';
export type { MongoDBInstrumentationOptions } from './instrumentation/mongodb.js';
export type { RedisInstrumentationOptions } from './instrumentation/redis.js';
export type { BullMQInstrumentationOptions } from './instrumentation/bullmq.js';
export type { AxiosInstrumentationOptions } from './instrumentation/axios.js';
export type { Logger, LogFormat } from './utils/logger.js';
export { setLogger, getLogger, setDebugMode, setLogLevel, setLogFormat, getLogFormat, jsonLogger } from './utils/logger.js';
export type { SDKInitOptions, RemoteConfig, ResolvedSDKConfig, TransportOptions, PlanTier, PlanFeatures, RemoteConfigResponse, FeaturesConfig, SamplingConfig, InstrumentationConfig, TracingRemoteConfig, ErrorsConfig, LoggingConfig, MetricsRemoteConfig, ProfilingConfig, SecurityConfig, TransportRemoteConfig, LimitsConfig, KillswitchesConfig, VersionPolicyConfig, CacheConfig, ConfigMeta, ConfigDiff, TransportRouteName, TransportEndpointConfig, } from './types/config.js';
export type { SDKEvent, RequestEvent, ErrorEvent, MessageEvent, MetricEvent, EventMetadata, StackFrame, LogEvent, ProfileEvent, ReplayEvent, CronCheckInEvent, SpanEvent, } from './types/event.js';
export type { Breadcrumb, BreadcrumbInput, BreadcrumbHint } from './types/breadcrumb.js';
export type { SeverityLevel } from './types/severity.js';
export { Severity, severityFromString } from './types/severity.js';
export type { SDKPlugin, PluginMeta, PluginContext, EventProcessor, BreadcrumbProcessor } from './types/plugin.js';
export type { CaptureErrorOptions, ParsedError, ErrorGrouping } from './types/error.js';
export type { TransportResult, IngestPayload, TransportHealth, TransportAdapter, RouteTransportHealth, MultiRouteTransportHealth } from './types/transport.js';
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
export { LoggingSubsystem } from './subsystems/logging-subsystem.js';
export { ProfilingSubsystem } from './subsystems/profiling-subsystem.js';
export { CronSubsystem } from './subsystems/cron-subsystem.js';
export { getPlanDefaults, isFeatureAllowed } from './core/plan-gate.js';
export { EventLoopLagMonitor } from './utils/event-loop-lag.js';
export type { EventLoopLagStats, EventLoopLagOptions } from './utils/event-loop-lag.js';
export { detectResources, detectOtelResource } from './utils/resource-detector.js';
export type { ResourceAttributes } from './utils/resource-detector.js';
export { RetryBudget, globalRetryBudget } from './transport/retry.js';
export { otelMetrics } from './metrics/otel-adapter.js';
export type { OtelMetricsConfig } from './metrics/otel-adapter.js';
export { errorDeduplicator } from './processors/deduplicator.js';
export { persistentStorage } from './storage/persistent-storage.js';
export { sourceMapResolver } from './processors/source-map-resolver.js';
export { metricsRegistry } from './metrics/registry.js';
export { slowRequestDetector } from './processors/slow-request-detector.js';
export { persistenceGovernor } from './storage/persistence-governor.js';
export type { PersistentStorageOptions } from './storage/persistent-storage.js';
export type { DurabilityTier, PersistenceGovernorOptions, PersistenceStats } from './storage/persistence-governor.js';
export type { SourceMapResolverOptions } from './processors/source-map-resolver.js';
export type { MetricRegistryOptions, HistogramOptions, CounterOptions, MetricLabels } from './metrics/registry.js';
export type { SlowRequestOptions } from './processors/slow-request-detector.js';
/**
 * Get a comprehensive SDK health snapshot for operational dashboards.
 * Safe to call at any time — returns degraded info if SDK isn't initialized.
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
    slowRequests: {
        totalChecked: number;
        totalSlow: number;
        slowRate: number;
        trackedRoutes: number;
    };
};
//# sourceMappingURL=index.d.ts.map