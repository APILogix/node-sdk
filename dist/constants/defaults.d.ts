/**
 * Baked-in SDK defaults, safety ceilings, and bootstrap fallbacks.
 *
 * Three categories of constants live in this file:
 *
 *   1. **Legacy defaults (`DEFAULT_*`)** — knobs the legacy `/v1/init`
 *      response and `ResolvedSDKConfig` still rely on. Kept for backward
 *      compatibility while the schema migrates.
 *
 *   2. **Safe defaults (`SAFE_DEFAULTS_*`, `BAKED_IN_REMOTE_CONFIG`)** —
 *      what the SDK runs on when no remote config has arrived yet. Tuned
 *      to be permissive enough to capture telemetry on a fresh install
 *      but conservative enough to avoid surprises (transport off until
 *      remote config provides URLs).
 *
 *   3. **Safety ceilings (`SAFETY_CEILINGS`)** — hard upper bounds the SDK
 *      enforces on every numeric field that comes from remote config. The
 *      backend can lower a value below the ceiling, never raise above it.
 *      This is a defence against malformed or malicious config payloads —
 *      e.g. `maxQueueSize: 1e9` would otherwise OOM the host process.
 */
import type { RemoteConfigResponse, FeaturesConfig, SamplingConfig, KillswitchesConfig, LimitsConfig, PrivacyConfig, TransportRemoteConfig, InstrumentationConfig, RuntimeConfig, EntitlementsConfig } from '../types/config.js';
/** Base URL must be provided via SDK_BASE_URL env var or `baseUrl` in SDK config. */
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
export declare const SAFETY_CEILINGS: Readonly<{
    readonly maxSpansPerTrace: 5000;
    readonly maxSpanAttributes: 500;
    readonly maxAttributeLength: number;
    readonly maxPayloadSize: number;
    readonly maxQueueSize: 100000;
    readonly maxMemoryMb: 1024;
    readonly maxCpuOverheadPercent: 25;
    readonly batchSize: 5000;
    readonly flushIntervalMs: number;
    readonly timeoutMs: 60000;
    readonly retryMaxRetries: 10;
    readonly retryBaseDelayMs: 30000;
    readonly configTtlSeconds: number;
}>;
/**
 * Floor values applied alongside ceilings. Mostly used to keep flush
 * intervals from being set so low they melt the event loop.
 */
export declare const SAFETY_FLOORS: Readonly<{
    readonly flushIntervalMs: 100;
    readonly timeoutMs: 250;
    readonly configTtlSeconds: 30;
}>;
export declare const SAFE_DEFAULTS_FEATURES: Readonly<FeaturesConfig>;
export declare const SAFE_DEFAULTS_SAMPLING: Readonly<SamplingConfig>;
export declare const SAFE_DEFAULTS_KILLSWITCHES: Readonly<KillswitchesConfig>;
export declare const SAFE_DEFAULTS_LIMITS: Readonly<LimitsConfig>;
export declare const SAFE_DEFAULTS_PRIVACY: Readonly<PrivacyConfig>;
export declare const SAFE_DEFAULTS_INSTRUMENTATION: Readonly<InstrumentationConfig>;
/**
 * Transport defaults intentionally use placeholder URLs — the SDK will not
 * actually attempt to send to these because `SAFE_DEFAULTS_KILLSWITCHES`
 * sets `disableTransport: true`. Real URLs arrive with the first remote
 * config response.
 */
export declare const SAFE_DEFAULTS_TRANSPORT: Readonly<TransportRemoteConfig>;
export declare const SAFE_DEFAULTS_RUNTIME: Readonly<RuntimeConfig>;
/**
 * Entitlement safe defaults are fail-open: when no remote config has
 * arrived (or the backend predates the entitlements block), every
 * developer API behaves as entitled. Only an explicit `false` from the
 * control plane turns an API into a no-op.
 */
export declare const SAFE_DEFAULTS_ENTITLEMENTS: Readonly<EntitlementsConfig>;
/**
 * Complete baked-in remote config. Used as the base layer in config merge:
 *
 *     Baked-in → Remote → User overrides
 *
 * Also used as the fallback when remote config can't be fetched at all.
 */
export declare const BAKED_IN_REMOTE_CONFIG: Readonly<RemoteConfigResponse>;
//# sourceMappingURL=defaults.d.ts.map