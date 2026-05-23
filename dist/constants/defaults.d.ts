/**
 * Baked-in SDK defaults and safe fallbacks.
 *
 * These constants serve two purposes:
 * 1. Backward-compatible legacy defaults (DEFAULT_*)
 * 2. Safe defaults for the remote config system (SAFE_DEFAULTS_*)
 *
 * Safe defaults are used when the config fetch fails and no cache exists.
 * In safe mode: all features OFF, sampling 0, transport disabled.
 *
 * Config merge priority: Baked-in → Remote Config → User init() options.
 */
import type { RemoteConfigResponse, FeaturesConfig, SamplingConfig, KillswitchesConfig, LimitsConfig, SecurityConfig, TransportRemoteConfig, TracingRemoteConfig, ErrorsConfig, LoggingConfig, MetricsRemoteConfig, ProfilingConfig, InstrumentationConfig, VersionPolicyConfig, CacheConfig } from '../types/config.js';
/**
 * Base URL must be provided via SDK_BASE_URL env var or `baseUrl` in SDK config.
 * Empty string signals "not configured" — init will throw a clear error.
 */
export declare const DEFAULT_BASE_URL: string;
export declare const DEFAULT_TIMEOUT_MS = 5000;
export declare const DEFAULT_BATCH_SIZE = 50;
export declare const DEFAULT_FLUSH_INTERVAL_MS = 5000;
export declare const DEFAULT_MAX_QUEUE_SIZE = 1000;
export declare const DEFAULT_MAX_RETRIES = 3;
export declare const DEFAULT_MAX_PAYLOAD_BYTES: number;
/** Maximum time to wait for the initial config fetch before falling back to safe defaults. */
export declare const CONFIG_FETCH_TIMEOUT_MS = 3000;
/** Background retry interval when initial config fetch fails (30 seconds). */
export declare const CONFIG_RETRY_INTERVAL_MS = 30000;
/** Minimum interval between config refresh attempts (5 seconds). */
export declare const CONFIG_REFRESH_MIN_INTERVAL_MS = 5000;
export declare const SAFE_DEFAULTS_FEATURES: Readonly<FeaturesConfig>;
export declare const SAFE_DEFAULTS_SAMPLING: Readonly<SamplingConfig>;
export declare const SAFE_DEFAULTS_KILLSWITCHES: Readonly<KillswitchesConfig>;
export declare const SAFE_DEFAULTS_LIMITS: Readonly<LimitsConfig>;
export declare const SAFE_DEFAULTS_SECURITY: Readonly<SecurityConfig>;
export declare const SAFE_DEFAULTS_TRACING: Readonly<TracingRemoteConfig>;
export declare const SAFE_DEFAULTS_ERRORS: Readonly<ErrorsConfig>;
export declare const SAFE_DEFAULTS_LOGGING: Readonly<LoggingConfig>;
export declare const SAFE_DEFAULTS_METRICS: Readonly<MetricsRemoteConfig>;
export declare const SAFE_DEFAULTS_PROFILING: Readonly<ProfilingConfig>;
export declare const SAFE_DEFAULTS_INSTRUMENTATION: Readonly<InstrumentationConfig>;
export declare const SAFE_DEFAULTS_TRANSPORT: Readonly<TransportRemoteConfig>;
export declare const SAFE_DEFAULTS_VERSION_POLICY: Readonly<VersionPolicyConfig>;
export declare const SAFE_DEFAULTS_CACHE: Readonly<CacheConfig>;
/**
 * Complete baked-in remote config defaults.
 * Used as the base layer in config merge: Baked-in → Remote → User overrides.
 */
export declare const BAKED_IN_REMOTE_CONFIG: Readonly<RemoteConfigResponse>;
//# sourceMappingURL=defaults.d.ts.map