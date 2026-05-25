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

import type {
  RemoteConfigResponse,
  FeaturesConfig,
  SamplingConfig,
  KillswitchesConfig,
  LimitsConfig,
  PrivacyConfig,
  TransportRemoteConfig,
  InstrumentationConfig,
  RuntimeConfig,
} from '../types/config.js'
import { REMOTE_CONFIG_SCHEMA_VERSION } from '../types/config.js'

// ─── Legacy Defaults ────────────────────────────────────────────────────────

/** Base URL must be provided via SDK_BASE_URL env var or `baseUrl` in SDK config. */
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

// ─── Safety Ceilings ────────────────────────────────────────────────────────
//
// Hard upper bounds applied to every numeric value the backend can send. The
// SDK clamps to these ceilings during config merge so a config typo can never
// blow out memory, disk, or per-event CPU budget.

export const SAFETY_CEILINGS = Object.freeze({
  // Limits
  maxSpansPerTrace: 5_000,
  maxSpanAttributes: 500,
  maxAttributeLength: 16 * 1024,         // 16 KiB
  maxPayloadSize: 4 * 1024 * 1024,       // 4 MiB
  maxQueueSize: 100_000,                 // events
  maxMemoryMb: 1024,                     // 1 GiB
  maxCpuOverheadPercent: 25,

  // Transport
  batchSize: 5_000,
  flushIntervalMs: 5 * 60 * 1000,        // 5 min
  timeoutMs: 60_000,                     // 60s
  retryMaxRetries: 10,
  retryBaseDelayMs: 30_000,

  // Runtime
  configTtlSeconds: 24 * 60 * 60,        // 24h
} as const)

/**
 * Floor values applied alongside ceilings. Mostly used to keep flush
 * intervals from being set so low they melt the event loop.
 */
export const SAFETY_FLOORS = Object.freeze({
  flushIntervalMs: 100,
  timeoutMs: 250,
  configTtlSeconds: 30,
} as const)

// ─── Safe Defaults — per-section frozen objects ─────────────────────────────

export const SAFE_DEFAULTS_FEATURES: Readonly<FeaturesConfig> = Object.freeze({
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
})

export const SAFE_DEFAULTS_SAMPLING: Readonly<SamplingConfig> = Object.freeze({
  traces: 0,
  requests: 0,
  errors: 0,
  profiles: 0,
  replays: 0,
  routes: Object.freeze({}),
})

export const SAFE_DEFAULTS_KILLSWITCHES: Readonly<KillswitchesConfig> = Object.freeze({
  disableSDK: false,
  disableTracing: false,
  disableMetrics: false,
  disableTransport: true, // Transport off until remote config provides URLs.
  disableProfiling: false,
  disableErrors: false,
  disableLogs: false,
})

export const SAFE_DEFAULTS_LIMITS: Readonly<LimitsConfig> = Object.freeze({
  maxSpansPerTrace: 500,
  maxSpanAttributes: 100,
  maxAttributeLength: 2048,
  maxPayloadSize: 262_144,
  maxQueueSize: 10_000,
  maxMemoryMb: 256,
  maxCpuOverheadPercent: 5,
})

export const SAFE_DEFAULTS_PRIVACY: Readonly<PrivacyConfig> = Object.freeze({
  capture: Object.freeze({
    headers: false,
    body: false,
    response: false,
    query: false,
    cookies: false,
  }),
  scrubbing: Object.freeze({
    enabled: true,
    headers: Object.freeze(['authorization', 'cookie', 'x-api-key', 'x-auth-token'] as string[]),
    fields: Object.freeze(['password', 'token', 'secret', 'creditCard', 'ssn', 'nationalId', 'apiKey'] as string[]),
  }),
  piiDetection: Object.freeze({
    enabled: true,
    maskEmails: true,
    maskPhones: true,
    maskIPs: false,
  }),
})

export const SAFE_DEFAULTS_INSTRUMENTATION: Readonly<InstrumentationConfig> = Object.freeze({
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
})

/**
 * Transport defaults intentionally use placeholder URLs — the SDK will not
 * actually attempt to send to these because `SAFE_DEFAULTS_KILLSWITCHES`
 * sets `disableTransport: true`. Real URLs arrive with the first remote
 * config response.
 */
export const SAFE_DEFAULTS_TRANSPORT: Readonly<TransportRemoteConfig> = Object.freeze({
  retry: Object.freeze({
    enabled: true,
    maxRetries: 3,
    backoff: 'exponential' as const,
    baseDelayMs: 500,
  }),
  queue: Object.freeze({
    overflowStrategy: 'drop_oldest' as const,
  }),
  keepAlive: true,
  routes: Object.freeze({
    traces: Object.freeze({ url: '', batchSize: 100, flushIntervalMs: 5000, timeoutMs: 5000, compression: 'gzip' as const, priority: 'high' as const }),
    requests: Object.freeze({ url: '', batchSize: 200, flushIntervalMs: 2000, timeoutMs: 3000, compression: 'gzip' as const, priority: 'high' as const }),
    errors: Object.freeze({ url: '', batchSize: 10, flushIntervalMs: 1000, timeoutMs: 3000, compression: 'gzip' as const, priority: 'critical' as const }),
    metrics: Object.freeze({ url: '', batchSize: 100, flushIntervalMs: 10000, timeoutMs: 5000, compression: 'gzip' as const, priority: 'normal' as const }),
    logs: Object.freeze({ url: '', batchSize: 50, flushIntervalMs: 10000, timeoutMs: 5000, compression: 'gzip' as const, priority: 'normal' as const }),
    profiles: Object.freeze({ url: '', batchSize: 5, flushIntervalMs: 30000, timeoutMs: 15000, compression: 'gzip' as const, priority: 'low' as const }),
    events: Object.freeze({ url: '', batchSize: 50, flushIntervalMs: 5000, timeoutMs: 5000, compression: 'gzip' as const, priority: 'normal' as const }),
    crons: Object.freeze({ url: '', batchSize: 1, flushIntervalMs: 0, timeoutMs: 5000, compression: 'none' as const, priority: 'high' as const }),
    replays: Object.freeze({ url: '', batchSize: 1, flushIntervalMs: 5000, timeoutMs: 30000, compression: 'gzip' as const, priority: 'low' as const }),
  }),
})

export const SAFE_DEFAULTS_RUNTIME: Readonly<RuntimeConfig> = Object.freeze({
  configTtlSeconds: 300,
  staleWhileRevalidate: true,
})

// ─── Complete Baked-In Remote Config ────────────────────────────────────────

/**
 * Complete baked-in remote config. Used as the base layer in config merge:
 *
 *     Baked-in → Remote → User overrides
 *
 * Also used as the fallback when remote config can't be fetched at all.
 */
export const BAKED_IN_REMOTE_CONFIG: Readonly<RemoteConfigResponse> = Object.freeze({
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
})
