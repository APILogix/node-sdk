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
import { REMOTE_CONFIG_SCHEMA_VERSION } from '../types/config.js';
// ─── Legacy Defaults ────────────────────────────────────────────────────────
/** Production SaaS API origin used when neither `baseUrl` nor `SDK_BASE_URL` is provided. */
export const DEFAULT_API_BASE_URL = 'https://api.veyontix.com';
/**
 * Resolve the SDK API origin from highest to lowest precedence:
 * explicit init option, environment override, production SaaS endpoint.
 */
export function resolveApiBaseUrl(baseUrl) {
    return baseUrl ?? process.env['SDK_BASE_URL'] ?? DEFAULT_API_BASE_URL;
}
export const DEFAULT_TIMEOUT_MS = 5000;
export const DEFAULT_BATCH_SIZE = 50;
export const DEFAULT_FLUSH_INTERVAL_MS = 5000;
export const DEFAULT_MAX_QUEUE_SIZE = 1000;
export const DEFAULT_MAX_RETRIES = 3;
export const DEFAULT_MAX_PAYLOAD_BYTES = 512 * 1024;
// ─── Config Fetch Constants ─────────────────────────────────────────────────
/** Maximum time to wait for the initial config fetch before falling back to safe defaults. */
export const CONFIG_FETCH_TIMEOUT_MS = 3000;
/** Background retry interval when initial config fetch fails (30 seconds). */
export const CONFIG_RETRY_INTERVAL_MS = 30_000;
/** Minimum interval between config refresh attempts (5 seconds). */
export const CONFIG_REFRESH_MIN_INTERVAL_MS = 5_000;
// ─── Safety Ceilings ────────────────────────────────────────────────────────
//
// Hard upper bounds applied to every numeric value the backend can send. The
// SDK clamps to these ceilings during config merge so a config typo can never
// blow out memory, disk, or per-event CPU budget.
export const SAFETY_CEILINGS = Object.freeze({
    // Limits
    maxSpansPerTrace: 5_000,
    maxSpanAttributes: 500,
    maxAttributeLength: 16 * 1024, // 16 KiB
    maxPayloadSize: 4 * 1024 * 1024, // 4 MiB
    maxQueueSize: 100_000, // events
    maxMemoryMb: 1024, // 1 GiB
    maxCpuOverheadPercent: 25,
    // Transport
    batchSize: 5_000,
    flushIntervalMs: 5 * 60 * 1000, // 5 min
    timeoutMs: 60_000, // 60s
    retryMaxRetries: 10,
    retryBaseDelayMs: 30_000,
    // Runtime
    configTtlSeconds: 24 * 60 * 60, // 24h
});
/**
 * Floor values applied alongside ceilings. Mostly used to keep flush
 * intervals from being set so low they melt the event loop.
 */
export const SAFETY_FLOORS = Object.freeze({
    flushIntervalMs: 100,
    timeoutMs: 250,
    configTtlSeconds: 30,
});
// ─── Safe Defaults — per-section frozen objects ─────────────────────────────
export const SAFE_DEFAULTS_FEATURES = Object.freeze({
    tracing: false,
    requestCapture: false,
    errors: false,
    metrics: false,
    logging: false,
    profiling: false,
    crons: false,
    sessionReplay: false,
    runtimeMetrics: false,
    eventLoopMonitoring: false,
    gcMonitoring: false,
});
export const SAFE_DEFAULTS_SAMPLING = Object.freeze({
    traces: 0,
    requests: 0,
    errors: 0,
    profiles: 0,
    replays: 0,
    metrics: 0,
    routes: Object.freeze({}),
});
export const SAFE_DEFAULTS_KILLSWITCHES = Object.freeze({
    disableSDK: false,
    disableTracing: false,
    disableMetrics: false,
    disableTransport: true, // Transport off until remote config provides URLs.
    disableProfiling: false,
    disableErrors: false,
    disableLogs: false,
});
export const SAFE_DEFAULTS_LIMITS = Object.freeze({
    maxSpansPerTrace: 500,
    maxSpanAttributes: 100,
    maxAttributeLength: 2048,
    maxPayloadSize: 262_144,
    maxQueueSize: 10_000,
    maxMemoryMb: 256,
    maxCpuOverheadPercent: 5,
    tenantGovernance: Object.freeze({
        enabled: false,
        maxTenantsTracked: 1_000,
        quotaPerWindow: 10_000,
        windowDurationMs: 60_000,
        criticalReserve: 100,
    }),
});
export const SAFE_DEFAULTS_PRIVACY = Object.freeze({
    capture: Object.freeze({
        headers: false,
        body: false,
        response: false,
        query: false,
        cookies: false,
    }),
    scrubbing: Object.freeze({
        enabled: true,
        headers: Object.freeze(['authorization', 'cookie', 'x-api-key', 'x-auth-token']),
        // Includes OAuth/OIDC flow keys so authorization codes and tokens in
        // redirect query strings or JSON bodies are never exfiltrated.
        fields: Object.freeze([
            'password', 'token', 'secret', 'creditCard', 'ssn', 'nationalId', 'apiKey',
            'code', 'id_token', 'access_token', 'refresh_token', 'client_secret', 'assertion',
        ]),
    }),
    piiDetection: Object.freeze({
        enabled: true,
        maskEmails: true,
        maskPhones: true,
        maskIPs: true,
    }),
});
export const SAFE_DEFAULTS_INSTRUMENTATION = Object.freeze({
    http: true,
    https: true,
    fetch: true,
    axios: true,
    fastify: Object.freeze({ enabled: true, captureHooks: true, captureValidationErrors: true }),
    express: Object.freeze({ enabled: true }),
    graphql: Object.freeze({ enabled: false, captureResolvers: false }),
    prisma: Object.freeze({ enabled: false, captureQueries: false, captureParams: false }),
    mongodb: false,
    redis: false,
    bullmq: false,
});
/**
 * Transport defaults intentionally use placeholder URLs — the SDK will not
 * actually attempt to send to these because `SAFE_DEFAULTS_KILLSWITCHES`
 * sets `disableTransport: true`. Real URLs arrive with the first remote
 * config response.
 */
export const SAFE_DEFAULTS_TRANSPORT = Object.freeze({
    retry: Object.freeze({
        enabled: true,
        maxRetries: 3,
        backoff: 'exponential',
        baseDelayMs: 500,
    }),
    queue: Object.freeze({
        overflowStrategy: 'drop_oldest',
        maxSize: 10_000,
        criticalReserve: 100,
    }),
    connections: Object.freeze({
        maxTotalConnections: 100,
        acquireTimeoutMs: 5_000,
    }),
    keepAlive: true,
    routes: Object.freeze({
        traces: Object.freeze({ url: '', batchSize: 500, flushIntervalMs: 5000, timeoutMs: 5000, compression: 'gzip', priority: 'high' }),
        requests: Object.freeze({ url: '', batchSize: 500, flushIntervalMs: 5000, timeoutMs: 3000, compression: 'gzip', priority: 'high' }),
        spans: Object.freeze({ url: '', batchSize: 500, flushIntervalMs: 5000, timeoutMs: 5000, compression: 'gzip', priority: 'high' }),
        errors: Object.freeze({ url: '', batchSize: 100, flushIntervalMs: 1000, timeoutMs: 3000, compression: 'gzip', priority: 'critical' }),
        metrics: Object.freeze({ url: '', batchSize: 1000, flushIntervalMs: 10000, timeoutMs: 5000, compression: 'gzip', priority: 'normal' }),
        logs: Object.freeze({ url: '', batchSize: 200, flushIntervalMs: 10000, timeoutMs: 5000, compression: 'gzip', priority: 'normal' }),
        profiles: Object.freeze({ url: '', batchSize: 5, flushIntervalMs: 30000, timeoutMs: 15000, compression: 'gzip', priority: 'low' }),
        events: Object.freeze({ url: '', batchSize: 50, flushIntervalMs: 5000, timeoutMs: 5000, compression: 'gzip', priority: 'normal' }),
        crons: Object.freeze({ url: '', batchSize: 1, flushIntervalMs: 0, timeoutMs: 5000, compression: 'none', priority: 'high' }),
        replays: Object.freeze({ url: '', batchSize: 5, flushIntervalMs: 10000, timeoutMs: 30000, compression: 'gzip', priority: 'low' }),
    }),
});
export const SAFE_DEFAULTS_RUNTIME = Object.freeze({
    configTtlSeconds: 300,
    staleWhileRevalidate: true,
});
/**
 * Entitlement safe defaults are fail-open: when no remote config has
 * arrived (or the backend predates the entitlements block), every
 * developer API behaves as entitled. Only an explicit `false` from the
 * control plane turns an API into a no-op.
 */
export const SAFE_DEFAULTS_ENTITLEMENTS = Object.freeze({
    customSpans: true,
    customMetrics: true,
    profiling: true,
    logging: true,
    sessionReplay: true,
    crons: true,
    requestCapture: true,
    tracing: true,
    errors: true,
    metrics: true,
});
// ─── Complete Baked-In Remote Config ────────────────────────────────────────
/**
 * Complete baked-in remote config. Used as the base layer in config merge:
 *
 *     Baked-in → Remote → User overrides
 *
 * Also used as the fallback when remote config can't be fetched at all.
 */
export const BAKED_IN_REMOTE_CONFIG = Object.freeze({
    schemaVersion: REMOTE_CONFIG_SCHEMA_VERSION,
    sdk: Object.freeze({ projectId: '', environment: 'production' }),
    features: SAFE_DEFAULTS_FEATURES,
    sampling: SAFE_DEFAULTS_SAMPLING,
    instrumentation: SAFE_DEFAULTS_INSTRUMENTATION,
    privacy: SAFE_DEFAULTS_PRIVACY,
    limits: SAFE_DEFAULTS_LIMITS,
    killswitches: SAFE_DEFAULTS_KILLSWITCHES,
    transport: SAFE_DEFAULTS_TRANSPORT,
    runtime: SAFE_DEFAULTS_RUNTIME,
    meta: Object.freeze({ generatedAt: '', generatedBy: 'baked-in' }),
    entitlements: SAFE_DEFAULTS_ENTITLEMENTS,
});
