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
// ─── Legacy Defaults (preserved for backward compatibility) ─────────────────
/**
 * Base URL must be provided via SDK_BASE_URL env var or `baseUrl` in SDK config.
 * Empty string signals "not configured" — init will throw a clear error.
 */
export const DEFAULT_BASE_URL = process.env['SDK_BASE_URL'] || '';
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
// ─── Safe Defaults — per-section frozen objects ─────────────────────────────
export const SAFE_DEFAULTS_FEATURES = Object.freeze({
    tracing: false,
    metrics: false,
    logging: false,
    errors: false,
    profiling: false,
    crons: false,
    sessionReplay: false,
    aiDetection: false,
    dynamicSampling: false,
    runtimeMetrics: false,
    eventLoopMonitoring: false,
    gcMonitoring: false,
    sourceMaps: false,
    releaseTracking: false,
});
export const SAFE_DEFAULTS_SAMPLING = Object.freeze({
    traces: 0,
    errors: 0,
    profiles: 0,
    replays: 0,
    routes: Object.freeze({}),
});
export const SAFE_DEFAULTS_KILLSWITCHES = Object.freeze({
    disableSDK: false,
    disableTracing: false,
    disableMetrics: false,
    disableTransport: true, // Transport disabled in safe mode
    disableProfiling: false,
    disableErrors: false,
    disableLogs: false,
});
export const SAFE_DEFAULTS_LIMITS = Object.freeze({
    maxPayloadSize: 262144,
    maxAttributesPerEvent: 100,
    maxAttributeLength: 2048,
    maxBreadcrumbs: 200,
    maxEventsPerSecond: 10000,
    maxMemoryUsageMb: 256,
    maxCpuOverheadPercent: 5,
});
export const SAFE_DEFAULTS_SECURITY = Object.freeze({
    scrubbing: Object.freeze({
        enabled: true,
        headers: Object.freeze(['authorization', 'cookie', 'x-api-key', 'x-auth-token']),
        bodyFields: Object.freeze(['password', 'token', 'secret', 'creditCard', 'ssn', 'nationalId', 'apiKey']),
        queryParams: Object.freeze(['token', 'apikey', 'password', 'secret']),
    }),
    piiDetection: Object.freeze({
        enabled: true,
        maskEmails: true,
        maskPhones: true,
        maskIPs: false,
    }),
});
export const SAFE_DEFAULTS_TRACING = Object.freeze({
    capture: Object.freeze({
        headers: false,
        body: false,
        response: false,
        query: true,
        cookies: false,
    }),
    maxSpansPerTrace: 2000,
    maxSpanAttributes: 100,
    maxTraceDurationMs: 300000,
    ignoredRoutes: Object.freeze(['/health', '/metrics', '/favicon.ico']),
    ignoredMethods: Object.freeze(['OPTIONS']),
    propagation: Object.freeze({
        w3c: true,
        baggage: true,
        b3: false,
    }),
});
export const SAFE_DEFAULTS_ERRORS = Object.freeze({
    captureUnhandledRejections: true,
    captureUncaughtExceptions: true,
    captureConsoleErrors: true,
    stackTraceLimit: 50,
    attachSourceContext: true,
    grouping: Object.freeze({
        enabled: true,
        normalizePaths: true,
    }),
});
export const SAFE_DEFAULTS_LOGGING = Object.freeze({
    enabled: true,
    captureConsole: true,
    levels: Object.freeze(['error', 'warn', 'info']),
    maxLogSize: 32768,
});
export const SAFE_DEFAULTS_METRICS = Object.freeze({
    runtime: true,
    eventLoop: true,
    gc: true,
    system: true,
    intervalMs: 10000,
    histograms: true,
    percentiles: Object.freeze([50, 90, 95, 99]),
});
export const SAFE_DEFAULTS_PROFILING = Object.freeze({
    enabled: false,
    cpu: true,
    heap: true,
    sampleRate: 0.02,
    maxDurationMs: 30000,
});
export const SAFE_DEFAULTS_INSTRUMENTATION = Object.freeze({
    http: true,
    https: true,
    fastify: Object.freeze({ enabled: true, captureHooks: true, captureValidationErrors: true }),
    express: Object.freeze({ enabled: false }),
    graphql: Object.freeze({ enabled: true, captureResolvers: true }),
    prisma: Object.freeze({ enabled: true, captureQueries: true, captureParams: false }),
    mongodb: true,
    redis: true,
    bullmq: true,
    fetch: true,
    axios: true,
});
export const SAFE_DEFAULTS_TRANSPORT = Object.freeze({
    endpoints: Object.freeze({
        traces: Object.freeze({ url: 'https://traces.pulse.dev/v1/traces', priority: 'high', batchSize: 100, flushIntervalMs: 5000, compression: 'gzip', timeoutMs: 5000 }),
        errors: Object.freeze({ url: 'https://errors.pulse.dev/v1/errors', priority: 'critical', batchSize: 10, flushIntervalMs: 1000, compression: 'gzip', timeoutMs: 3000 }),
        logs: Object.freeze({ url: 'https://logs.pulse.dev/v1/logs', priority: 'normal', batchSize: 50, flushIntervalMs: 10000, compression: 'gzip', timeoutMs: 5000 }),
        metrics: Object.freeze({ url: 'https://metrics.pulse.dev/v1/metrics', priority: 'normal', batchSize: 100, flushIntervalMs: 10000, compression: 'gzip', timeoutMs: 5000 }),
        profiles: Object.freeze({ url: 'https://profiles.pulse.dev/v1/profiles', priority: 'low', batchSize: 5, flushIntervalMs: 30000, compression: 'gzip', timeoutMs: 15000 }),
        replays: Object.freeze({ url: 'https://replays.pulse.dev/v1/replays', priority: 'low', batchSize: 1, flushIntervalMs: 5000, compression: 'gzip', timeoutMs: 30000 }),
        crons: Object.freeze({ url: 'https://crons.pulse.dev/v1/checkins', priority: 'high', batchSize: 1, flushIntervalMs: 0, compression: 'none', timeoutMs: 5000 }),
        envelope: Object.freeze({ url: 'https://ingest.pulse.dev/v1/envelope', priority: 'normal', batchSize: 50, flushIntervalMs: 5000, compression: 'gzip', timeoutMs: 5000 }),
    }),
    shared: Object.freeze({
        queue: Object.freeze({ maxSize: 10000, overflowStrategy: 'drop_oldest' }),
        retry: Object.freeze({ enabled: true, maxRetries: 5, backoff: 'exponential', baseDelayMs: 500 }),
        keepAlive: true,
        connectionPool: Object.freeze({ maxConnectionsPerRoute: 10, maxTotalConnections: 50 }),
    }),
});
export const SAFE_DEFAULTS_VERSION_POLICY = Object.freeze({
    minimumVersion: '0.0.0',
    latestVersion: '999.999.999',
    blockedVersions: Object.freeze([]),
    forceUpgrade: false,
    upgradeMessage: '',
});
export const SAFE_DEFAULTS_CACHE = Object.freeze({
    ttlSeconds: 300,
    staleWhileRevalidate: true,
});
// ─── Complete Baked-In Remote Config ────────────────────────────────────────
/**
 * Complete baked-in remote config defaults.
 * Used as the base layer in config merge: Baked-in → Remote → User overrides.
 */
export const BAKED_IN_REMOTE_CONFIG = Object.freeze({
    sdk: Object.freeze({ dsn: '', projectId: '', environment: 'production' }),
    features: SAFE_DEFAULTS_FEATURES,
    sampling: SAFE_DEFAULTS_SAMPLING,
    instrumentation: SAFE_DEFAULTS_INSTRUMENTATION,
    tracing: SAFE_DEFAULTS_TRACING,
    errors: SAFE_DEFAULTS_ERRORS,
    logging: SAFE_DEFAULTS_LOGGING,
    metrics: SAFE_DEFAULTS_METRICS,
    profiling: SAFE_DEFAULTS_PROFILING,
    security: SAFE_DEFAULTS_SECURITY,
    transport: SAFE_DEFAULTS_TRANSPORT,
    limits: SAFE_DEFAULTS_LIMITS,
    killswitches: Object.freeze({
        disableSDK: false,
        disableTracing: false,
        disableMetrics: false,
        disableTransport: false,
        disableProfiling: false,
        disableErrors: false,
        disableLogs: false,
    }),
    versionPolicy: SAFE_DEFAULTS_VERSION_POLICY,
    cache: SAFE_DEFAULTS_CACHE,
    meta: Object.freeze({ generatedAt: '', generatedBy: 'baked-in', configHash: '' }),
});
