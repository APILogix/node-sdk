import { SAFETY_CEILINGS } from './limits.js';
import type { NormalizedRemoteConfig, SdkIdentityConfig, FeaturesConfig, SamplingConfig, TransportRemoteConfig, LimitsConfig, KillswitchesConfig, PrivacyConfig, InstrumentationConfig, EntitlementsConfig, ConfigMeta, OfflineQueueConfig, ProfilingConfig, SessionReplayConfig, ErrorsConfig, TracingConfig, MetricsConfig, LogsConfig, CronsConfig, TransportRouteName, TransportRouteConfig } from '../types/config.js';
/** Local Pulse backend origin used by the SDK control plane. */
export declare const DEFAULT_API_BASE_URL = "http://127.0.0.1:5000";
/** Resolve the control-plane origin with support for environment overrides. */
export declare function resolveApiBaseUrl(): string;
export { SAFETY_CEILINGS };
export declare const DEFAULT_SDK_IDENTITY: Readonly<SdkIdentityConfig>;
export declare const DEFAULT_FEATURES: Readonly<FeaturesConfig>;
export declare const DEFAULT_SAMPLING: Readonly<SamplingConfig>;
export declare const DEFAULT_TRANSPORT_ROUTES: Readonly<Record<TransportRouteName, TransportRouteConfig>>;
export declare const DEFAULT_TRANSPORT: Readonly<TransportRemoteConfig>;
export declare const DEFAULT_OFFLINE_QUEUE: Readonly<OfflineQueueConfig>;
export declare const DEFAULT_PROFILING: Readonly<ProfilingConfig>;
export declare const DEFAULT_REPLAY: Readonly<SessionReplayConfig>;
export declare const DEFAULT_ERRORS: Readonly<ErrorsConfig>;
export declare const DEFAULT_TRACING: Readonly<TracingConfig>;
export declare const DEFAULT_METRICS: Readonly<MetricsConfig>;
export declare const DEFAULT_LOGS: Readonly<LogsConfig>;
export declare const DEFAULT_CRONS: Readonly<CronsConfig>;
export declare const DEFAULT_LIMITS: Readonly<LimitsConfig>;
export declare const DEFAULT_KILLSWITCHES: Readonly<KillswitchesConfig>;
export declare const DEFAULT_PRIVACY: Readonly<PrivacyConfig>;
export declare const DEFAULT_INSTRUMENTATION: Readonly<InstrumentationConfig>;
export declare const DEFAULT_ENTITLEMENTS: Readonly<EntitlementsConfig>;
export declare const DEFAULT_META: Readonly<ConfigMeta>;
/**
 * Single authoritative immutable composite default snapshot.
 * Deep frozen at process initialization.
 */
export declare const DEFAULT_REMOTE_CONFIG: Readonly<NormalizedRemoteConfig>;
/** Safe defaults alias */
export declare const SAFE_CONFIG_DEFAULTS: Readonly<NormalizedRemoteConfig>;
