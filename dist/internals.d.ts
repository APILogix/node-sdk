/**
 * Internal SDK surface.
 *
 * ⚠️  NO STABILITY GUARANTEES.
 *
 * This entry point exposes engines, processors, and runtime singletons that
 * the SDK uses internally. The shapes here can change in any release without
 * warning. They are exported only for power users and our own integration
 * tests — applications should depend on the public surface in `index.ts`.
 *
 * If you find yourself reaching for something here in production code, open
 * an issue so we can promote that capability into the public API instead.
 */
export { ConfigManager, ConfigState } from './core/config-manager.js';
export { KillswitchEngine } from './core/killswitch-engine.js';
export { FeatureController } from './core/feature-controller.js';
export { SamplingEngine } from './core/sampling-engine.js';
export { LimitsEngine } from './core/limits-engine.js';
export { VersionPolicy } from './core/version-policy.js';
export { diffConfigs } from './core/config-differ.js';
export { SecurityScrubber } from './processors/security-scrubber.js';
export { TransportRouter } from './transport/transport-router.js';
export { tenantGovernor, TenantGovernor } from './core/tenant-isolation.js';
export { enqueueEvent } from './core/event-pipeline.js';
export { client } from './core/client.js';
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
export { persistenceGovernor } from './storage/persistence-governor.js';
export type { PersistentStorageOptions } from './storage/persistent-storage.js';
export type { DurabilityTier, PersistenceGovernorOptions, PersistenceStats } from './storage/persistence-governor.js';
export type { SourceMapResolverOptions } from './processors/source-map-resolver.js';
export type { MetricRegistryOptions, HistogramOptions, CounterOptions, MetricLabels } from './metrics/registry.js';
export { getSessionManager } from './session/session-manager.js';
export type { Session, SessionManagerOptions } from './session/session-manager.js';
export { PulseSpan } from './tracing/span.js';
export { getLogger, jsonLogger, setLogFormat, getLogFormat } from './utils/logger.js';
export type { RemoteConfigResponse, FeaturesConfig, SamplingConfig, RouteSamplingRates, InstrumentationConfig, PrivacyConfig, PrivacyCaptureConfig, ScrubbingConfig, PiiDetectionConfig, LimitsConfig, KillswitchesConfig, TransportRemoteConfig, TransportRouteConfig, TransportRouteName, TransportRetryConfig, TransportQueueConfig, RuntimeConfig, ConfigMeta, ConfigDiff, } from './types/config.js';
export { REMOTE_CONFIG_SCHEMA_VERSION } from './types/config.js';
export type { TransportResult, IngestPayload, TransportHealth, TransportAdapter, RouteTransportHealth, MultiRouteTransportHealth, } from './types/transport.js';
//# sourceMappingURL=internals.d.ts.map