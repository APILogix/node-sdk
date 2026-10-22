import { SAFETY_CEILINGS } from './limits.js'
import type {
  NormalizedRemoteConfig,
  SdkIdentityConfig,
  FeaturesConfig,
  SamplingConfig,
  TransportRemoteConfig,
  LimitsConfig,
  KillswitchesConfig,
  PrivacyConfig,
  InstrumentationConfig,
  EntitlementsConfig,
  ConfigMeta,
  OfflineQueueConfig,
  ProfilingConfig,
  ErrorsConfig,
  TracingConfig,
  MetricsConfig,
  LogsConfig,
  CronsConfig,
  TransportRouteName,
  TransportRouteConfig,
} from '../types/config.js'

/** Production backend origin used by the SDK control plane. */
export const BACKEND_BASE_URL = 'https://api.lynktrace.com'

/** Default control-plane API base URL alias. */
export const DEFAULT_API_BASE_URL = BACKEND_BASE_URL

/** Resolve the control-plane origin with support for environment overrides. */
export function resolveApiBaseUrl(): string {
  if (typeof process !== 'undefined' && process.env) {
    const customUrl =
      process.env['LYNKTRACE_ENDPOINT'] ||
      process.env['LYNKTRACE_API_URL'] ||
      process.env['LYNKTRACE_BASE_URL'] ||
      process.env['PULSE_ENDPOINT'] ||
      process.env['PULSE_API_URL'] ||
      process.env['PULSE_BASE_URL'] ||
      // Legacy SDK integration tests and deployed applications use this
      // scoped alias. Keep generic BACKEND_URL intentionally unsupported to
      // avoid accidentally routing telemetry through a host application's
      // unrelated backend.
      process.env['SDK_BASE_URL']
    if (customUrl && typeof customUrl === 'string' && customUrl.trim().length > 0) {
      let resolved = customUrl.trim()
      if (resolved.endsWith('/')) resolved = resolved.slice(0, -1)
      resolved = resolved.replace(/^http:\/\/localhost(?::(\d+))?/i, (_match, port) => {
        return port ? `http://127.0.0.1:${port}` : 'http://127.0.0.1'
      })
      return resolved
    }
  }
  return BACKEND_BASE_URL
}

export { SAFETY_CEILINGS }

export const DEFAULT_SDK_IDENTITY: Readonly<SdkIdentityConfig> = Object.freeze({
  projectId: 'default-project',
  service: 'default-service',
  environment: 'production',
  release: '0.0.0',
})

export const DEFAULT_FEATURES: Readonly<FeaturesConfig> = Object.freeze({
  tracing: true,
  requestCapture: true,
  errors: true,
  metrics: true,
  logging: true,
  profiling: true,
  crons: true,
  runtimeMetrics: true,
  eventLoopMonitoring: true,
  gcMonitoring: true,
  adaptiveSampling: false,
})

export const DEFAULT_SAMPLING: Readonly<SamplingConfig> = Object.freeze({
  traces: 1,
  requests: 1,
  spans: 1,
  errors: 1,
  messages: 1,
  profiles: 1,
  metrics: 1,
  logs: 1,
  events: 1,
  crons: 1,
  routes: Object.freeze({}),
  adaptive: false,
})

export const DEFAULT_TRANSPORT_ROUTES: Readonly<Record<TransportRouteName, TransportRouteConfig>> = Object.freeze({
  traces: Object.freeze({ url: 'https://127.0.0.1:0/v1/traces', batchSize: 500, flushIntervalMs: 5000, timeoutMs: 5000, compression: 'gzip' as const, priority: 'high' as const }),
  requests: Object.freeze({ url: 'https://127.0.0.1:0/v1/requests', batchSize: 500, flushIntervalMs: 5000, timeoutMs: 3000, compression: 'gzip' as const, priority: 'high' as const }),
  spans: Object.freeze({ url: 'https://127.0.0.1:0/v1/spans', batchSize: 500, flushIntervalMs: 5000, timeoutMs: 5000, compression: 'gzip' as const, priority: 'high' as const }),
  errors: Object.freeze({ url: 'https://127.0.0.1:0/v1/errors', batchSize: 100, flushIntervalMs: 1000, timeoutMs: 3000, compression: 'gzip' as const, priority: 'critical' as const }),
  metrics: Object.freeze({ url: 'https://127.0.0.1:0/v1/metrics', batchSize: 1000, flushIntervalMs: 10000, timeoutMs: 5000, compression: 'gzip' as const, priority: 'normal' as const }),
  logs: Object.freeze({ url: 'https://127.0.0.1:0/v1/logs', batchSize: 200, flushIntervalMs: 10000, timeoutMs: 5000, compression: 'gzip' as const, priority: 'normal' as const }),
  profiles: Object.freeze({ url: 'https://127.0.0.1:0/v1/profiles', batchSize: 5, flushIntervalMs: 30000, timeoutMs: 15000, compression: 'gzip' as const, priority: 'low' as const }),
  events: Object.freeze({ url: 'https://127.0.0.1:0/v1/events', batchSize: 50, flushIntervalMs: 5000, timeoutMs: 5000, compression: 'gzip' as const, priority: 'normal' as const }),
  crons: Object.freeze({ url: 'https://127.0.0.1:0/v1/crons', batchSize: 1, flushIntervalMs: 0, timeoutMs: 5000, compression: 'none' as const, priority: 'high' as const }),
})

export const DEFAULT_TRANSPORT: Readonly<TransportRemoteConfig> = Object.freeze({
  retry: Object.freeze({ enabled: true, maxRetries: 3, backoff: 'exponential' as const, baseDelayMs: 500 }),
  queue: Object.freeze({ overflowStrategy: 'drop_oldest' as const, maxSize: 10_000, criticalReserve: 100 }),
  connections: Object.freeze({
    maxTotalConnections: 50,
    maxConnectionsPerRoute: Object.freeze({
      errors: 10,
      events: 10,
      traces: 20,
      spans: 20,
      metrics: 10,
      logs: 10,
      profiles: 5,
      crons: 5,
      requests: 20,
    }),
    acquireTimeoutMs: 5000,
  }),
  keepAlive: true,
  routes: DEFAULT_TRANSPORT_ROUTES,
})

export const DEFAULT_OFFLINE_QUEUE: Readonly<OfflineQueueConfig> = Object.freeze({
  enabled: true,
  maxFileSizeBytes: 10 * 1024 * 1024,
  maxEvents: 10_000,
  eventTtlMs: 24 * 60 * 60 * 1000,
  ioTimeoutMs: 5_000,
  flushDebounceMs: 1_000,
})

export const DEFAULT_PROFILING: Readonly<ProfilingConfig> = Object.freeze({
  enabled: true,
  cpu: true,
  heap: true,
  sampleRate: 1,
  maxDurationMs: 30_000,
})
export const DEFAULT_ERRORS: Readonly<ErrorsConfig> = Object.freeze({
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

export const DEFAULT_TRACING: Readonly<TracingConfig> = Object.freeze({
  maxSpansPerTrace: 5_000,
  maxSpanAttributes: 200,
  maxTraceDurationMs: 5 * 60 * 1000,
  propagation: Object.freeze({
    w3c: true,
    baggage: true,
    b3: false,
  }),
})

export const DEFAULT_METRICS: Readonly<MetricsConfig> = Object.freeze({
  runtimeMetrics: true,
  eventLoopMonitoring: true,
  gcMonitoring: true,
  pushIntervalMs: 10_000,
  cardinalityLimit: 2_000,
})

export const DEFAULT_LOGS: Readonly<LogsConfig> = Object.freeze({
  enabled: true,
  captureConsole: true,
  levels: Object.freeze(['debug', 'info', 'warning', 'warn', 'error', 'fatal']),
  maxLogSize: 32 * 1024,
})

export const DEFAULT_CRONS: Readonly<CronsConfig> = Object.freeze({
  enabled: true,
  checkInMarginMs: 60_000,
  timeoutMs: 300_000,
})

export const DEFAULT_LIMITS: Readonly<LimitsConfig> = Object.freeze({
  maxSpansPerTrace: 5_000,
  maxSpanAttributes: 200,
  maxAttributeLength: 8_192,
  maxPayloadSize: 4_194_304,
  maxQueueSize: 100_000,
  maxMemoryMb: 256,
  tenantGovernance: Object.freeze({
    enabled: false,
    maxTenantsTracked: 1_000,
    quotaPerWindow: 10_000,
    windowDurationMs: 60_000,
    criticalReserve: 100,
  }),
  persistenceGovernance: Object.freeze({
    maxPersistPerMinute: 100_000,
    adaptive: true,
    budgetExceededLogIntervalMs: 60_000,
  }),
})

export const DEFAULT_KILLSWITCHES: Readonly<KillswitchesConfig> = Object.freeze({
  disableSDK: false,
  disableTracing: false,
  disableMetrics: false,
  disableTransport: false,
  disableProfiling: false,
  disableErrors: false,
  disableLogs: false,
})

export const DEFAULT_PRIVACY: Readonly<PrivacyConfig> = Object.freeze({
  capture: Object.freeze({
    headers: false,
    body: false,
    response: false,
    query: false,
    cookies: false,
  }),
  scrubbing: Object.freeze({
    enabled: true,
    headers: Object.freeze(['authorization', 'cookie', 'set-cookie', 'x-api-key', 'x-auth-token']),
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
    maskCreditCards: true,
    maskSSNs: true,
  }),
})

export const DEFAULT_INSTRUMENTATION: Readonly<InstrumentationConfig> = Object.freeze({
  http: true,
  https: true,
  fetch: true,
  axios: true,
  fastify: Object.freeze({ enabled: true, captureHooks: true, captureValidationErrors: true }),
  express: Object.freeze({ enabled: true }),
  graphql: Object.freeze({ enabled: true, captureResolvers: true }),
  prisma: Object.freeze({ enabled: true, captureQueries: true, captureParams: false }),
  mongodb: true,
  redis: true,
  bullmq: true,
  pg: true,
  mysql2: true,
  eventEmitterPatch: false,

  // Cloud & NoSQL Databases
  dynamodb: Object.freeze({ enabled: true, captureQueries: true, captureParams: false }),
  cassandra: Object.freeze({ enabled: true, captureQueries: true, captureParams: false }),
  elasticsearch: Object.freeze({ enabled: true, captureQueries: true }),
  mssql: Object.freeze({ enabled: true, captureQueries: true, captureParams: false }),
  sqlite: Object.freeze({ enabled: true, captureQueries: true, captureParams: false }),

  // ORMs & Query Builders
  typeorm: Object.freeze({ enabled: true, captureQueries: true, captureParams: false }),
  drizzle: Object.freeze({ enabled: true, captureQueries: true, captureParams: false }),
  mikroorm: true,
  sequelize: true,
  knex: true,

  // Distributed Messaging & Streaming
  kafkajs: Object.freeze({ enabled: true, emitConsumerBatchSpans: true, captureMessageKey: false }),
  amqplib: Object.freeze({ enabled: true, captureMessageData: false }),
  sqs: true,
  sns: true,
  pubsub: true,

  // RPC & Infrastructure
  grpc: true,
  nestjs: true,
  dns: false,
})

export const DEFAULT_ENTITLEMENTS: Readonly<EntitlementsConfig> = Object.freeze({
  customSpans: true,
  customMetrics: true,
  profiling: true,
  logging: true,
  crons: true,
  requestCapture: true,
  tracing: true,
  errors: true,
  metrics: true,
})

export const DEFAULT_META: Readonly<ConfigMeta> = Object.freeze({
  generatedAt: '1970-01-01T00:00:00.000Z',
  generatedBy: 'sdk-safe-defaults',
  configHash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
})

/**
 * Single authoritative immutable composite default snapshot.
 * Deep frozen at process initialization.
 */
export const DEFAULT_REMOTE_CONFIG: Readonly<NormalizedRemoteConfig> = Object.freeze({
  schemaVersion: 1,
  sdk: DEFAULT_SDK_IDENTITY,
  features: DEFAULT_FEATURES,
  sampling: DEFAULT_SAMPLING,
  transport: DEFAULT_TRANSPORT,
  offlineQueue: DEFAULT_OFFLINE_QUEUE,
  profiling: DEFAULT_PROFILING,
  errors: DEFAULT_ERRORS,
  tracing: DEFAULT_TRACING,
  metrics: DEFAULT_METRICS,
  logs: DEFAULT_LOGS,
  crons: DEFAULT_CRONS,
  limits: DEFAULT_LIMITS,
  killswitches: DEFAULT_KILLSWITCHES,
  privacy: DEFAULT_PRIVACY,
  instrumentation: DEFAULT_INSTRUMENTATION,
  entitlements: DEFAULT_ENTITLEMENTS,
  meta: DEFAULT_META,
})

/** Safe defaults alias */
export const SAFE_CONFIG_DEFAULTS = DEFAULT_REMOTE_CONFIG
