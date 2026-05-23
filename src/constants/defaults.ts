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

import type {
  RemoteConfigResponse,
  FeaturesConfig,
  SamplingConfig,
  KillswitchesConfig,
  LimitsConfig,
  SecurityConfig,
  TransportRemoteConfig,
  TracingRemoteConfig,
  ErrorsConfig,
  LoggingConfig,
  MetricsRemoteConfig,
  ProfilingConfig,
  InstrumentationConfig,
  VersionPolicyConfig,
  CacheConfig,
} from '../types/config.js'

// ─── Legacy Defaults (preserved for backward compatibility) ─────────────────

/**
 * Base URL must be provided via SDK_BASE_URL env var or `baseUrl` in SDK config.
 * Empty string signals "not configured" — init will throw a clear error.
 */
export const DEFAULT_BASE_URL = process.env['SDK_BASE_URL'] || ''

export const DEFAULT_TIMEOUT_MS = 5000
export const DEFAULT_BATCH_SIZE = 50
export const DEFAULT_FLUSH_INTERVAL_MS = 5000
export const DEFAULT_MAX_QUEUE_SIZE = 1000
export const DEFAULT_MAX_RETRIES = 3
export const DEFAULT_MAX_PAYLOAD_BYTES = 512 * 1024

// ─── Config Fetch Constants ─────────────────────────────────────────────────

/** Maximum time to wait for the initial config fetch before falling back to safe defaults. */
export const CONFIG_FETCH_TIMEOUT_MS = 3000

/** Background retry interval when initial config fetch fails (30 seconds). */
export const CONFIG_RETRY_INTERVAL_MS = 30_000

/** Minimum interval between config refresh attempts (5 seconds). */
export const CONFIG_REFRESH_MIN_INTERVAL_MS = 5_000

// ─── Safe Defaults — per-section frozen objects ─────────────────────────────

export const SAFE_DEFAULTS_FEATURES: Readonly<FeaturesConfig> = Object.freeze({
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
})

export const SAFE_DEFAULTS_SAMPLING: Readonly<SamplingConfig> = Object.freeze({
  traces: 0,
  errors: 0,
  profiles: 0,
  replays: 0,
  routes: Object.freeze({}),
})

export const SAFE_DEFAULTS_KILLSWITCHES: Readonly<KillswitchesConfig> = Object.freeze({
  disableSDK: false,
  disableTracing: false,
  disableMetrics: false,
  disableTransport: true, // Transport disabled in safe mode
  disableProfiling: false,
  disableErrors: false,
  disableLogs: false,
})

export const SAFE_DEFAULTS_LIMITS: Readonly<LimitsConfig> = Object.freeze({
  maxPayloadSize: 262144,
  maxAttributesPerEvent: 100,
  maxAttributeLength: 2048,
  maxBreadcrumbs: 200,
  maxEventsPerSecond: 10000,
  maxMemoryUsageMb: 256,
  maxCpuOverheadPercent: 5,
})

export const SAFE_DEFAULTS_SECURITY: Readonly<SecurityConfig> = Object.freeze({
  scrubbing: Object.freeze({
    enabled: true,
    headers: Object.freeze(['authorization', 'cookie', 'x-api-key', 'x-auth-token'] as const),
    bodyFields: Object.freeze(['password', 'token', 'secret', 'creditCard', 'ssn', 'nationalId', 'apiKey'] as const),
    queryParams: Object.freeze(['token', 'apikey', 'password', 'secret'] as const),
  }),
  piiDetection: Object.freeze({
    enabled: true,
    maskEmails: true,
    maskPhones: true,
    maskIPs: false,
  }),
})

export const SAFE_DEFAULTS_TRACING: Readonly<TracingRemoteConfig> = Object.freeze({
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
  ignoredRoutes: Object.freeze(['/health', '/metrics', '/favicon.ico'] as const),
  ignoredMethods: Object.freeze(['OPTIONS'] as const),
  propagation: Object.freeze({
    w3c: true,
    baggage: true,
    b3: false,
  }),
})

export const SAFE_DEFAULTS_ERRORS: Readonly<ErrorsConfig> = Object.freeze({
  captureUnhandledRejections: true,
  captureUncaughtExceptions: true,
  captureConsoleErrors: true,
  stackTraceLimit: 50,
  attachSourceContext: true,
  grouping: Object.freeze({
    enabled: true,
    normalizePaths: true,
  }),
})

export const SAFE_DEFAULTS_LOGGING: Readonly<LoggingConfig> = Object.freeze({
  enabled: true,
  captureConsole: true,
  levels: Object.freeze(['error', 'warn', 'info'] as const),
  maxLogSize: 32768,
})

export const SAFE_DEFAULTS_METRICS: Readonly<MetricsRemoteConfig> = Object.freeze({
  runtime: true,
  eventLoop: true,
  gc: true,
  system: true,
  intervalMs: 10000,
  histograms: true,
  percentiles: Object.freeze([50, 90, 95, 99] as const),
})

export const SAFE_DEFAULTS_PROFILING: Readonly<ProfilingConfig> = Object.freeze({
  enabled: false,
  cpu: true,
  heap: true,
  sampleRate: 0.02,
  maxDurationMs: 30000,
})

export const SAFE_DEFAULTS_INSTRUMENTATION: Readonly<InstrumentationConfig> = Object.freeze({
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
})

export const SAFE_DEFAULTS_TRANSPORT: Readonly<TransportRemoteConfig> = Object.freeze({
  endpoints: Object.freeze({
    traces: Object.freeze({ url: 'https://traces.pulse.dev/v1/traces', priority: 'high' as const, batchSize: 100, flushIntervalMs: 5000, compression: 'gzip' as const, timeoutMs: 5000 }),
    errors: Object.freeze({ url: 'https://errors.pulse.dev/v1/errors', priority: 'critical' as const, batchSize: 10, flushIntervalMs: 1000, compression: 'gzip' as const, timeoutMs: 3000 }),
    logs: Object.freeze({ url: 'https://logs.pulse.dev/v1/logs', priority: 'normal' as const, batchSize: 50, flushIntervalMs: 10000, compression: 'gzip' as const, timeoutMs: 5000 }),
    metrics: Object.freeze({ url: 'https://metrics.pulse.dev/v1/metrics', priority: 'normal' as const, batchSize: 100, flushIntervalMs: 10000, compression: 'gzip' as const, timeoutMs: 5000 }),
    profiles: Object.freeze({ url: 'https://profiles.pulse.dev/v1/profiles', priority: 'low' as const, batchSize: 5, flushIntervalMs: 30000, compression: 'gzip' as const, timeoutMs: 15000 }),
    replays: Object.freeze({ url: 'https://replays.pulse.dev/v1/replays', priority: 'low' as const, batchSize: 1, flushIntervalMs: 5000, compression: 'gzip' as const, timeoutMs: 30000 }),
    crons: Object.freeze({ url: 'https://crons.pulse.dev/v1/checkins', priority: 'high' as const, batchSize: 1, flushIntervalMs: 0, compression: 'none' as const, timeoutMs: 5000 }),
    envelope: Object.freeze({ url: 'https://ingest.pulse.dev/v1/envelope', priority: 'normal' as const, batchSize: 50, flushIntervalMs: 5000, compression: 'gzip' as const, timeoutMs: 5000 }),
  }),
  shared: Object.freeze({
    queue: Object.freeze({ maxSize: 10000, overflowStrategy: 'drop_oldest' as const }),
    retry: Object.freeze({ enabled: true, maxRetries: 5, backoff: 'exponential' as const, baseDelayMs: 500 }),
    keepAlive: true,
    connectionPool: Object.freeze({ maxConnectionsPerRoute: 10, maxTotalConnections: 50 }),
  }),
})

export const SAFE_DEFAULTS_VERSION_POLICY: Readonly<VersionPolicyConfig> = Object.freeze({
  minimumVersion: '0.0.0',
  latestVersion: '999.999.999',
  blockedVersions: Object.freeze([] as const),
  forceUpgrade: false,
  upgradeMessage: '',
})

export const SAFE_DEFAULTS_CACHE: Readonly<CacheConfig> = Object.freeze({
  ttlSeconds: 300,
  staleWhileRevalidate: true,
})

// ─── Complete Baked-In Remote Config ────────────────────────────────────────

/**
 * Complete baked-in remote config defaults.
 * Used as the base layer in config merge: Baked-in → Remote → User overrides.
 */
export const BAKED_IN_REMOTE_CONFIG: Readonly<RemoteConfigResponse> = Object.freeze({
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
})
