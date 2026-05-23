import { z } from 'zod'
import type { SDKPlugin, EventProcessor, BreadcrumbProcessor } from './plugin.js'
import type { SeverityLevel } from './severity.js'

// ─── Plan Tiers ─────────────────────────────────────────────────────────────

/**
 * Plan tier determines which SDK features are available.
 * Controlled by the backend — the SDK cannot override plan limits.
 */
export type PlanTier = 'free' | 'pro' | 'enterprise'

/**
 * Feature gates and limits for a plan.
 * The backend sends these alongside the remote config.
 * The SDK uses these to cap/clamp user-provided overrides.
 */
export interface PlanFeatures {
  /** Plan tier name. */
  readonly tier: PlanTier

  // Feature gates — which capabilities are available on this plan
  readonly allowErrors: boolean
  readonly allowPerformance: boolean
  readonly allowTracing: boolean
  readonly allowMetrics: boolean
  readonly allowSessions: boolean
  readonly allowCustomPlugins: boolean
  readonly allowBeforeSend: boolean
  readonly allowSamplingOverride: boolean

  // Limits — hard caps for this plan
  readonly maxBreadcrumbs: number
  readonly maxPlugins: number
  readonly maxBatchSize: number
  readonly maxQueueSize: number
  readonly allowedCompression: readonly ('gzip' | 'brotli' | 'none')[]
}

// ─── Remote Config Response (from POST /v1/sdk-config) ──────────────────────

/**
 * Full remote config response from the backend.
 * This is the single source of truth for SDK behavior at runtime.
 * Every feature, limit, sampling rule, transport route, security policy,
 * and killswitch is driven by this config.
 */
export interface RemoteConfigResponse {
  readonly sdk: SdkIdentityConfig
  readonly features: FeaturesConfig
  readonly sampling: SamplingConfig
  readonly instrumentation: InstrumentationConfig
  readonly tracing: TracingRemoteConfig
  readonly errors: ErrorsConfig
  readonly logging: LoggingConfig
  readonly metrics: MetricsRemoteConfig
  readonly profiling: ProfilingConfig
  readonly security: SecurityConfig
  readonly transport: TransportRemoteConfig
  readonly limits: LimitsConfig
  readonly killswitches: KillswitchesConfig
  readonly versionPolicy: VersionPolicyConfig
  readonly cache: CacheConfig
  readonly meta: ConfigMeta
}

export interface SdkIdentityConfig {
  readonly dsn: string
  readonly projectId: string
  readonly environment: string
}

/** Feature toggles — if false, the subsystem is NEVER instantiated. */
export interface FeaturesConfig {
  readonly tracing: boolean
  readonly metrics: boolean
  readonly logging: boolean
  readonly errors: boolean
  readonly profiling: boolean
  readonly crons: boolean
  readonly sessionReplay: boolean
  readonly aiDetection: boolean
  readonly dynamicSampling: boolean
  readonly runtimeMetrics: boolean
  readonly eventLoopMonitoring: boolean
  readonly gcMonitoring: boolean
  readonly sourceMaps: boolean
  readonly releaseTracking: boolean
}

/** Sampling rates — all values in range [0.0, 1.0]. */
export interface SamplingConfig {
  readonly traces: number
  readonly errors: number
  readonly profiles: number
  readonly replays: number
  /** Per-URL-prefix overrides. Exact-match or prefix-match against req.url. */
  readonly routes: Readonly<Record<string, number>>
}

// ─── Instrumentation Config ─────────────────────────────────────────────────

export interface InstrumentationConfig {
  readonly http: boolean
  readonly https: boolean
  readonly fastify: FastifyInstrumentationConfig | boolean
  readonly express: ExpressInstrumentationConfig | boolean
  readonly graphql: GraphQLInstrumentationConfig | boolean
  readonly prisma: PrismaInstrumentationConfig | boolean
  readonly mongodb: boolean
  readonly redis: boolean
  readonly bullmq: boolean
  readonly fetch: boolean
  readonly axios: boolean
}

export interface FastifyInstrumentationConfig {
  readonly enabled: boolean
  readonly captureHooks: boolean
  readonly captureValidationErrors: boolean
}

export interface ExpressInstrumentationConfig {
  readonly enabled: boolean
}

export interface GraphQLInstrumentationConfig {
  readonly enabled: boolean
  readonly captureResolvers: boolean
}

export interface PrismaInstrumentationConfig {
  readonly enabled: boolean
  readonly captureQueries: boolean
  readonly captureParams: boolean
}

// ─── Tracing Config ─────────────────────────────────────────────────────────

export interface TracingRemoteConfig {
  readonly capture: TracingCaptureConfig
  readonly maxSpansPerTrace: number
  readonly maxSpanAttributes: number
  readonly maxTraceDurationMs: number
  readonly ignoredRoutes: readonly string[]
  readonly ignoredMethods: readonly string[]
  readonly propagation: TracingPropagationConfig
}

export interface TracingCaptureConfig {
  readonly headers: boolean
  readonly body: boolean
  readonly response: boolean
  readonly query: boolean
  readonly cookies: boolean
}

export interface TracingPropagationConfig {
  readonly w3c: boolean
  readonly baggage: boolean
  readonly b3: boolean
}

// ─── Errors Config ──────────────────────────────────────────────────────────

export interface ErrorsConfig {
  readonly captureUnhandledRejections: boolean
  readonly captureUncaughtExceptions: boolean
  readonly captureConsoleErrors: boolean
  readonly stackTraceLimit: number
  readonly attachSourceContext: boolean
  readonly grouping: ErrorGroupingConfig
}

export interface ErrorGroupingConfig {
  readonly enabled: boolean
  readonly normalizePaths: boolean
}

// ─── Logging Config ─────────────────────────────────────────────────────────

export interface LoggingConfig {
  readonly enabled: boolean
  readonly captureConsole: boolean
  readonly levels: readonly string[]
  readonly maxLogSize: number
}

// ─── Metrics Config ─────────────────────────────────────────────────────────

export interface MetricsRemoteConfig {
  readonly runtime: boolean
  readonly eventLoop: boolean
  readonly gc: boolean
  readonly system: boolean
  readonly intervalMs: number
  readonly histograms: boolean
  readonly percentiles: readonly number[]
}

// ─── Profiling Config ───────────────────────────────────────────────────────

export interface ProfilingConfig {
  readonly enabled: boolean
  readonly cpu: boolean
  readonly heap: boolean
  readonly sampleRate: number
  readonly maxDurationMs: number
}

// ─── Security Config ────────────────────────────────────────────────────────

export interface SecurityConfig {
  readonly scrubbing: ScrubbingConfig
  readonly piiDetection: PiiDetectionConfig
}

export interface ScrubbingConfig {
  readonly enabled: boolean
  readonly headers: readonly string[]
  readonly bodyFields: readonly string[]
  readonly queryParams: readonly string[]
}

export interface PiiDetectionConfig {
  readonly enabled: boolean
  readonly maskEmails: boolean
  readonly maskPhones: boolean
  readonly maskIPs: boolean
}

// ─── Transport Config ───────────────────────────────────────────────────────

export type TransportRouteName =
  | 'traces'
  | 'errors'
  | 'logs'
  | 'metrics'
  | 'profiles'
  | 'replays'
  | 'crons'
  | 'envelope'

export interface TransportEndpointConfig {
  readonly url: string
  readonly priority: 'critical' | 'high' | 'normal' | 'low'
  readonly batchSize: number
  readonly flushIntervalMs: number
  readonly compression: 'gzip' | 'none'
  readonly timeoutMs: number
}

export interface TransportRemoteConfig {
  readonly endpoints: Readonly<Record<TransportRouteName, TransportEndpointConfig>>
  readonly shared: TransportSharedConfig
}

export interface TransportSharedConfig {
  readonly queue: {
    readonly maxSize: number
    readonly overflowStrategy: 'drop_oldest'
  }
  readonly retry: {
    readonly enabled: boolean
    readonly maxRetries: number
    readonly backoff: 'exponential'
    readonly baseDelayMs: number
  }
  readonly keepAlive: boolean
  readonly connectionPool: {
    readonly maxConnectionsPerRoute: number
    readonly maxTotalConnections: number
  }
}

// ─── Limits Config ──────────────────────────────────────────────────────────

export interface LimitsConfig {
  readonly maxPayloadSize: number
  readonly maxAttributesPerEvent: number
  readonly maxAttributeLength: number
  readonly maxBreadcrumbs: number
  readonly maxEventsPerSecond: number
  readonly maxMemoryUsageMb: number
  readonly maxCpuOverheadPercent: number
}

// ─── Killswitches Config ────────────────────────────────────────────────────

export interface KillswitchesConfig {
  readonly disableSDK: boolean
  readonly disableTracing: boolean
  readonly disableMetrics: boolean
  readonly disableTransport: boolean
  readonly disableProfiling: boolean
  readonly disableErrors: boolean
  readonly disableLogs: boolean
}

// ─── Version Policy Config ──────────────────────────────────────────────────

export interface VersionPolicyConfig {
  readonly minimumVersion: string
  readonly latestVersion: string
  readonly blockedVersions: readonly string[]
  readonly forceUpgrade: boolean
  readonly upgradeMessage: string
}

// ─── Cache Config ───────────────────────────────────────────────────────────

export interface CacheConfig {
  readonly ttlSeconds: number
  readonly staleWhileRevalidate: boolean
}

// ─── Config Meta ────────────────────────────────────────────────────────────

export interface ConfigMeta {
  readonly generatedAt: string
  readonly generatedBy: string
  readonly configHash: string
}

// ─── Config Diff ────────────────────────────────────────────────────────────

/** Result of diffing two RemoteConfigResponse objects. */
export interface ConfigDiff {
  readonly featuresChanged: boolean
  readonly killswitchesChanged: boolean
  readonly samplingChanged: boolean
  readonly transportChanged: boolean
  readonly securityChanged: boolean
  readonly tracingChanged: boolean
  readonly errorsChanged: boolean
  readonly loggingChanged: boolean
  readonly metricsChanged: boolean
  readonly profilingChanged: boolean
  readonly limitsChanged: boolean
  readonly instrumentationChanged: boolean
  readonly changes: ReadonlyMap<string, { old: unknown; new: unknown }>
}

// ─── SDK Init Options (user-facing) ─────────────────────────────────────────

/**
 * Options passed to `createSDK()` or `init()`.
 * All fields except `apiKey` are optional — features are ON by default,
 * gated by the project's plan tier from the backend.
 */
export interface SDKInitOptions {
  /** Required. Project API key for authentication. */
  readonly apiKey: string

  /** Service/application name (e.g. "payments-service"). Defaults to "unknown-service". */
  readonly service?: string

  /** Deployment environment (e.g. "production", "staging"). Defaults to "production". */
  readonly environment?: string

  /** Release/version identifier (e.g. "1.4.2", git SHA). Defaults to "0.0.0-unknown". */
  readonly release?: string

  /** Enable/disable error tracking. Default: ON if plan allows. */
  readonly enableErrors?: boolean

  /** Enable/disable performance (request) tracking. Default: ON if plan allows. */
  readonly enablePerformance?: boolean

  /** Enable/disable tracing via OpenTelemetry. Default: ON if plan allows. */
  readonly enableTracing?: boolean

  /** Enable/disable metrics collection. Default: ON if plan allows. */
  readonly enableMetrics?: boolean

  /** Client-side sampling rate override (0.0–1.0). Only available on pro+ plans. */
  readonly sampleRate?: number

  /** Maximum breadcrumbs to retain in the ring buffer. Capped by plan limits. */
  readonly maxBreadcrumbs?: number

  /** Plugins to register during initialization. Plugin count capped by plan. */
  readonly plugins?: readonly SDKPlugin[]

  /** Event processors applied to every event before queuing. */
  readonly eventProcessors?: readonly EventProcessor[]

  /** Breadcrumb processor — return null to drop a breadcrumb. */
  readonly beforeBreadcrumb?: BreadcrumbProcessor

  /** Called before every event is sent — return null to drop. Pro+ plans only. */
  readonly beforeSend?: (event: Record<string, unknown>) => Record<string, unknown> | null | Promise<Record<string, unknown> | null>

  /** Transport configuration overrides. */
  readonly transport?: TransportOptions

  /** Enable SDK debug mode — verbose console.log output. Defaults to false. */
  readonly debug?: boolean

  /** Minimum severity level for SDK internal logging. Defaults to 'warning'. */
  readonly logLevel?: SeverityLevel

  /** Custom server base URL override. Uses SDK_BASE_URL env var or default. */
  readonly baseUrl?: string

  /** Remote config endpoint URL override. Defaults to `${baseUrl}/v1/sdk-config`. */
  readonly configUrl?: string

  /** Graceful shutdown timeout in milliseconds. Defaults to 10000. */
  readonly shutdownTimeoutMs?: number

  /** Source map configuration for de-obfuscating stack frames. */
  readonly sourceMaps?: {
    /** Additional directories to search for source maps. */
    readonly paths?: readonly string[]
    /** Enable loading remote source maps via HTTP. Default: false. */
    readonly allowRemote?: boolean
    /** Embed original source content in resolved frames. Default: false. */
    readonly embedSourceContent?: boolean
  }

  /** Data scrubbing configuration for payload governance. */
  readonly dataScrubbing?: {
    /** Additional sensitive headers to redact. */
    readonly sensitiveHeaders?: readonly string[]
    /** Additional sensitive keys to redact from JSON objects. */
    readonly sensitiveKeys?: readonly string[]
    /** Redact the entire request body. Default: false. */
    readonly redactRequestBody?: boolean
    /** Redact the entire response body. Default: false. */
    readonly redactResponseBody?: boolean
  }

  /** OpenTelemetry metrics configuration. */
  readonly otelMetrics?: {
    /** Max bucket size for exponential histograms. Default: 160 */
    readonly maxHistogramBuckets?: number
    /** Percentiles to compute. Default: [50, 75, 90, 95, 99] */
    readonly percentiles?: number[]
    /** Cardinality limit per instrument. Default: 2000 */
    readonly cardinalityLimit?: number
  }
}

/**
 * Transport configuration — controls batching, retries, compression.
 */
export interface TransportOptions {
  /** Maximum events per batch. Capped by plan limit. */
  readonly batchSize?: number
  /** Flush interval in milliseconds. */
  readonly flushIntervalMs?: number
  /** Maximum retry attempts for failed sends. */
  readonly maxRetries?: number
  /** Request timeout in milliseconds. */
  readonly timeoutMs?: number
  /** Enable payload compression ('gzip' | 'brotli' | 'none'). Availability depends on plan. */
  readonly compression?: 'gzip' | 'brotli' | 'none'
  /** Maximum payload size in bytes. */
  readonly maxPayloadBytes?: number
  /** Maximum concurrent in-flight batch sends. */
  readonly maxConcurrentSends?: number
}

// ─── Remote Config (legacy server-provided — kept for backward compat) ──────

/**
 * Configuration returned by the /v1/init endpoint.
 * This is the server's view of how this project should behave.
 * Now includes plan tier and feature gates.
 */
export interface RemoteConfig {
  readonly ingestUrl: string
  readonly samplingRate: number
  readonly enableErrors: boolean
  readonly enablePerformance: boolean
  readonly maxQueueSize: number
  readonly batchSize: number
  readonly flushIntervalMs: number
  readonly maxRetries: number
  readonly maxPayloadBytes: number

  /** Plan tier for this project. Defaults to 'free' if not provided. */
  readonly plan?: PlanTier | undefined
  /** Plan-specific feature gates. Built from defaults if not provided. */
  readonly planFeatures?: Partial<PlanFeatures> | undefined
}

// ─── Resolved Config (merged) ───────────────────────────────────────────────

/**
 * Fully resolved configuration — merges user options with remote config,
 * then clamps to plan limits. This is the internal source of truth.
 */
export interface ResolvedSDKConfig {
  readonly apiKey: string
  readonly service: string
  readonly environment: string
  readonly release: string
  readonly debug: boolean

  // Plan
  readonly plan: PlanTier
  readonly planFeatures: PlanFeatures

  // Feature flags (already clamped to plan)
  readonly enableErrors: boolean
  readonly enablePerformance: boolean
  readonly enableTracing: boolean
  readonly enableMetrics: boolean

  // Sampling
  readonly samplingRate: number

  // Limits
  readonly maxBreadcrumbs: number
  readonly maxQueueSize: number
  readonly shutdownTimeoutMs: number

  // Transport
  readonly ingestUrl: string
  readonly batchSize: number
  readonly flushIntervalMs: number
  readonly maxRetries: number
  readonly timeoutMs: number
  readonly compression: 'gzip' | 'brotli' | 'none'
  readonly maxPayloadBytes: number
  readonly maxConcurrentSends: number

  // Payload Governance
  readonly dataScrubbing: {
    sensitiveHeaders: string[]
    sensitiveKeys: string[]
    redactRequestBody: boolean
    redactResponseBody: boolean
  }

  // OTel Metrics
  readonly otelMetrics: {
    maxHistogramBuckets: number
    percentiles: number[]
    cardinalityLimit: number
  }

  /** Remote config response, if available. */
  readonly remoteConfig?: RemoteConfigResponse | undefined
}

// ─── Zod Schemas ────────────────────────────────────────────────────────────

export const sdkInitOptionsSchema = z.object({
  apiKey: z.string().trim().min(1, 'apiKey is required'),
  service: z.string().trim().min(1).optional(),
  environment: z.string().trim().min(1).optional(),
  release: z.string().trim().min(1).optional(),
  enableErrors: z.boolean().optional(),
  enablePerformance: z.boolean().optional(),
  enableTracing: z.boolean().optional(),
  enableMetrics: z.boolean().optional(),
  sampleRate: z.number().min(0).max(1).optional(),
  maxBreadcrumbs: z.number().int().min(0).max(1000).optional(),
  plugins: z.array(z.custom<SDKPlugin>()).readonly().optional(),
  eventProcessors: z.array(z.custom<EventProcessor>()).readonly().optional(),
  beforeBreadcrumb: z.custom<BreadcrumbProcessor>(value => typeof value === 'function').optional(),
  beforeSend: z
    .custom<(event: Record<string, unknown>) => Record<string, unknown> | null | Promise<Record<string, unknown> | null>>(
      value => typeof value === 'function'
    )
    .optional(),
  debug: z.boolean().optional(),
  logLevel: z.enum(['debug', 'info', 'warning', 'error', 'fatal']).optional(),
  baseUrl: z.string().url().optional(),
  configUrl: z.string().url().optional(),
  shutdownTimeoutMs: z.number().int().min(1000).max(60000).optional(),
  sourceMaps: z
    .object({
      paths: z.array(z.string()).readonly().optional(),
      allowRemote: z.boolean().optional(),
      embedSourceContent: z.boolean().optional(),
    })
    .optional(),
  dataScrubbing: z
    .object({
      sensitiveHeaders: z.array(z.string()).readonly().optional(),
      sensitiveKeys: z.array(z.string()).readonly().optional(),
      redactRequestBody: z.boolean().optional(),
      redactResponseBody: z.boolean().optional(),
    })
    .optional(),
  transport: z
    .object({
      batchSize: z.number().int().min(1).max(10000).optional(),
      flushIntervalMs: z.number().int().min(100).max(60000).optional(),
      maxRetries: z.number().int().min(0).max(20).optional(),
      timeoutMs: z.number().int().min(1000).max(30000).optional(),
      compression: z.enum(['gzip', 'brotli', 'none']).optional(),
      maxPayloadBytes: z.number().int().min(1024).max(10 * 1024 * 1024).optional(),
      maxConcurrentSends: z.number().int().min(1).max(20).optional(),
    })
    .optional(),
}).strict()
