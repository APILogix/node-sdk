import { z } from 'zod';
import type { SDKPlugin, EventProcessor, BreadcrumbProcessor } from './plugin.js';
import type { SeverityLevel } from './severity.js';
export type PlanTier = 'free' | 'pro' | 'enterprise';
export interface PlanFeatures {
    readonly tier: PlanTier;
    readonly allowErrors: boolean;
    readonly allowPerformance: boolean;
    readonly allowTracing: boolean;
    readonly allowMetrics: boolean;
    readonly allowSessions: boolean;
    readonly allowCustomPlugins: boolean;
    readonly allowBeforeSend: boolean;
    readonly allowSamplingOverride: boolean;
    readonly maxBreadcrumbs: number;
    readonly maxPlugins: number;
    readonly maxBatchSize: number;
    readonly maxQueueSize: number;
    readonly allowedCompression: readonly ('gzip' | 'brotli' | 'none')[];
}
/** Bumped on incompatible schema changes. SDKs reject configs with a higher major. */
export declare const REMOTE_CONFIG_SCHEMA_VERSION = 1;
export interface RemoteConfigResponse {
    /** Schema version. Must equal REMOTE_CONFIG_SCHEMA_VERSION on the SDK. */
    readonly schemaVersion: number;
    readonly sdk: SdkIdentityConfig;
    readonly features: FeaturesConfig;
    readonly sampling: SamplingConfig;
    readonly instrumentation: InstrumentationConfig;
    readonly privacy: PrivacyConfig;
    readonly limits: LimitsConfig;
    readonly killswitches: KillswitchesConfig;
    readonly transport: TransportRemoteConfig;
    readonly runtime: RuntimeConfig;
    readonly meta: ConfigMeta;
}
export interface SdkIdentityConfig {
    readonly projectId: string;
    readonly environment: string;
    readonly release?: string | undefined;
}
/**
 * Top-level feature toggles. When false, the SDK never instantiates the
 * subsystem nor processes events of that type.
 */
export interface FeaturesConfig {
    readonly tracing: boolean;
    readonly requestCapture: boolean;
    readonly errors: boolean;
    readonly metrics: boolean;
    readonly logging: boolean;
    readonly profiling: boolean;
    readonly crons: boolean;
    readonly sessionReplay: boolean;
    readonly runtimeMetrics: boolean;
    readonly eventLoopMonitoring: boolean;
    readonly gcMonitoring: boolean;
}
/**
 * Per-route override map. Each key is a route prefix; the value is a
 * partial set of per-event-type rates that overlay the global defaults.
 *
 * A rate of 0 effectively disables capture for that event type on the
 * matched route — which is how `/health` and similar are silenced (no more
 * separate `ignoredRoutes` list).
 */
export interface RouteSamplingRates {
    readonly traces?: number;
    readonly requests?: number;
    readonly errors?: number;
    readonly profiles?: number;
    readonly replays?: number;
    readonly metrics?: number;
}
export interface SamplingConfig {
    readonly traces: number;
    readonly requests: number;
    readonly errors: number;
    readonly profiles: number;
    readonly replays: number;
    /** Per-route overrides keyed by URL prefix. Longest prefix wins. */
    readonly routes: Readonly<Record<string, RouteSamplingRates>>;
}
export interface InstrumentationConfig {
    readonly http: boolean;
    readonly https: boolean;
    readonly fetch: boolean;
    readonly axios: boolean;
    readonly fastify: FastifyInstrumentationConfig | boolean;
    readonly express: ExpressInstrumentationConfig | boolean;
    readonly graphql: GraphQLInstrumentationConfig | boolean;
    readonly prisma: PrismaInstrumentationConfig | boolean;
    readonly mongodb: boolean;
    readonly redis: boolean;
    readonly bullmq: boolean;
}
export interface FastifyInstrumentationConfig {
    readonly enabled: boolean;
    readonly captureHooks: boolean;
    readonly captureValidationErrors: boolean;
}
export interface ExpressInstrumentationConfig {
    readonly enabled: boolean;
}
export interface GraphQLInstrumentationConfig {
    readonly enabled: boolean;
    readonly captureResolvers: boolean;
}
export interface PrismaInstrumentationConfig {
    readonly enabled: boolean;
    readonly captureQueries: boolean;
    readonly captureParams: boolean;
}
/**
 * Combined PII / scrubbing config. Replaces the older `security` block.
 *
 *   - `capture.*` controls which payload sections are *attached* to events
 *     (decision happens in middleware before security scrubbing runs).
 *   - `scrubbing.*` decides what gets redacted when those sections are
 *     attached.
 *   - `piiDetection.*` runs heuristic detection on free-form text fields.
 */
export interface PrivacyConfig {
    readonly capture: PrivacyCaptureConfig;
    readonly scrubbing: ScrubbingConfig;
    readonly piiDetection: PiiDetectionConfig;
}
export interface PrivacyCaptureConfig {
    readonly headers: boolean;
    readonly body: boolean;
    readonly response: boolean;
    readonly query: boolean;
    readonly cookies: boolean;
}
export interface ScrubbingConfig {
    readonly enabled: boolean;
    readonly headers: readonly string[];
    /** Body and query parameter keys that should be redacted. */
    readonly fields: readonly string[];
}
export interface PiiDetectionConfig {
    readonly enabled: boolean;
    readonly maskEmails: boolean;
    readonly maskPhones: boolean;
    readonly maskIPs: boolean;
}
/**
 * Hard caps that bound the SDK's resource use and per-event size. Backend
 * sets the values; the SDK clamps each one to a built-in safety ceiling
 * before applying it (see `SAFETY_CEILINGS` in constants/defaults).
 */
export interface LimitsConfig {
    readonly maxSpansPerTrace: number;
    readonly maxSpanAttributes: number;
    readonly maxAttributeLength: number;
    readonly maxPayloadSize: number;
    readonly maxQueueSize: number;
    readonly maxMemoryMb: number;
    readonly maxCpuOverheadPercent: number;
}
/**
 * Operational fire-extinguishers. Independent of `features.*` — used to
 * instantly silence the SDK (or a subsystem) without a redeploy when a
 * customer needs to stop emission immediately.
 */
export interface KillswitchesConfig {
    readonly disableSDK: boolean;
    readonly disableTracing: boolean;
    readonly disableMetrics: boolean;
    readonly disableTransport: boolean;
    readonly disableProfiling: boolean;
    readonly disableErrors: boolean;
    readonly disableLogs: boolean;
}
/**
 * Per-event-type ingestion routes. The set of route names is fixed by the
 * SDK contract — adding a new event type requires an SDK release.
 */
export type TransportRouteName = 'traces' | 'requests' | 'errors' | 'metrics' | 'logs' | 'profiles' | 'events' | 'crons' | 'replays';
export interface TransportRouteConfig {
    readonly url: string;
    readonly batchSize: number;
    readonly flushIntervalMs: number;
    readonly timeoutMs: number;
    readonly compression: 'gzip' | 'none';
    /** Internal scheduling priority. Optional in the wire format. */
    readonly priority?: 'critical' | 'high' | 'normal' | 'low';
}
export interface TransportRemoteConfig {
    readonly retry: TransportRetryConfig;
    readonly queue: TransportQueueConfig;
    readonly keepAlive: boolean;
    readonly routes: Readonly<Record<TransportRouteName, TransportRouteConfig>>;
}
export interface TransportRetryConfig {
    readonly enabled: boolean;
    readonly maxRetries: number;
    readonly backoff: 'exponential' | 'linear' | 'fixed';
    readonly baseDelayMs: number;
}
export interface TransportQueueConfig {
    readonly overflowStrategy: 'drop_oldest' | 'drop_newest';
}
export interface RuntimeConfig {
    readonly configTtlSeconds: number;
    readonly staleWhileRevalidate: boolean;
}
export interface ConfigMeta {
    readonly generatedAt: string;
    readonly generatedBy: string;
    readonly configHash?: string;
}
/** Result of diffing two RemoteConfigResponse objects. */
export interface ConfigDiff {
    readonly featuresChanged: boolean;
    readonly killswitchesChanged: boolean;
    readonly samplingChanged: boolean;
    readonly transportChanged: boolean;
    readonly privacyChanged: boolean;
    readonly limitsChanged: boolean;
    readonly instrumentationChanged: boolean;
    readonly runtimeChanged: boolean;
    readonly changes: ReadonlyMap<string, {
        old: unknown;
        new: unknown;
    }>;
}
/** @deprecated Use {@link PrivacyCaptureConfig}. */
export type TracingCaptureConfig = PrivacyCaptureConfig;
/** @deprecated The `tracing` block is gone; SDK-internal defaults live in `constants/internal-defaults`. */
export interface TracingRemoteConfig {
    readonly capture: PrivacyCaptureConfig;
    readonly maxSpansPerTrace: number;
    readonly maxSpanAttributes: number;
    readonly maxTraceDurationMs: number;
    readonly ignoredRoutes: readonly string[];
    readonly ignoredMethods: readonly string[];
    readonly propagation: {
        readonly w3c: boolean;
        readonly baggage: boolean;
        readonly b3: boolean;
    };
}
/** @deprecated The `errors` block is gone. SDK-internal defaults live in `constants/internal-defaults`. */
export interface ErrorsConfig {
    readonly captureUnhandledRejections: boolean;
    readonly captureUncaughtExceptions: boolean;
    readonly captureConsoleErrors: boolean;
    readonly stackTraceLimit: number;
    readonly attachSourceContext: boolean;
    readonly grouping: {
        readonly enabled: boolean;
        readonly normalizePaths: boolean;
    };
}
/** @deprecated The `logging` block is gone. SDK-internal defaults live in `constants/internal-defaults`. */
export interface LoggingConfig {
    readonly enabled: boolean;
    readonly captureConsole: boolean;
    readonly levels: readonly string[];
    readonly maxLogSize: number;
}
/** @deprecated The `profiling` block is gone. SDK-internal defaults live in `constants/internal-defaults`. */
export interface ProfilingConfig {
    readonly enabled: boolean;
    readonly cpu: boolean;
    readonly heap: boolean;
    readonly sampleRate: number;
    readonly maxDurationMs: number;
}
/** @deprecated Use {@link PrivacyConfig}. */
export type SecurityConfig = PrivacyConfig;
/** @deprecated `versionPolicy` is no longer in the wire schema. */
export interface VersionPolicyConfig {
    readonly minimumVersion: string;
    readonly latestVersion: string;
    readonly blockedVersions: readonly string[];
    readonly forceUpgrade: boolean;
    readonly upgradeMessage: string;
}
/** @deprecated Use {@link RuntimeConfig}. */
export type CacheConfig = RuntimeConfig;
/** @deprecated Use {@link TransportRouteConfig}. */
export type TransportEndpointConfig = TransportRouteConfig;
/**
 * Options passed to `createSDK()` or `init()`.
 * All fields except `apiKey` are optional. Per-feature toggles and limits
 * live in remote config — these init options are convenience overrides for
 * common cases (sample rate, environment, debug flag).
 */
export interface SDKInitOptions {
    readonly apiKey: string;
    readonly service?: string;
    readonly environment?: string;
    readonly release?: string;
    readonly enableErrors?: boolean;
    readonly enablePerformance?: boolean;
    readonly enableTracing?: boolean;
    readonly enableMetrics?: boolean;
    readonly sampleRate?: number;
    readonly maxBreadcrumbs?: number;
    readonly plugins?: readonly SDKPlugin[];
    readonly eventProcessors?: readonly EventProcessor[];
    readonly beforeBreadcrumb?: BreadcrumbProcessor;
    readonly beforeSend?: (event: Record<string, unknown>) => Record<string, unknown> | null | Promise<Record<string, unknown> | null>;
    readonly transport?: TransportOptions;
    readonly debug?: boolean;
    readonly logLevel?: SeverityLevel;
    readonly baseUrl?: string;
    readonly configUrl?: string;
    readonly shutdownTimeoutMs?: number;
    readonly sourceMaps?: {
        readonly paths?: readonly string[];
        readonly allowRemote?: boolean;
        readonly embedSourceContent?: boolean;
    };
    readonly dataScrubbing?: {
        readonly sensitiveHeaders?: readonly string[];
        readonly sensitiveKeys?: readonly string[];
        readonly redactRequestBody?: boolean;
        readonly redactResponseBody?: boolean;
    };
    readonly otelMetrics?: {
        readonly maxHistogramBuckets?: number;
        readonly percentiles?: number[];
        readonly cardinalityLimit?: number;
    };
}
export interface TransportOptions {
    readonly batchSize?: number;
    readonly flushIntervalMs?: number;
    readonly maxRetries?: number;
    readonly timeoutMs?: number;
    readonly compression?: 'gzip' | 'brotli' | 'none';
    readonly maxPayloadBytes?: number;
    readonly maxConcurrentSends?: number;
}
export interface RemoteConfig {
    readonly ingestUrl: string;
    readonly samplingRate: number;
    readonly enableErrors: boolean;
    readonly enablePerformance: boolean;
    readonly maxQueueSize: number;
    readonly batchSize: number;
    readonly flushIntervalMs: number;
    readonly maxRetries: number;
    readonly maxPayloadBytes: number;
    readonly plan?: PlanTier | undefined;
    readonly planFeatures?: Partial<PlanFeatures> | undefined;
}
export interface ResolvedSDKConfig {
    readonly apiKey: string;
    readonly service: string;
    readonly environment: string;
    readonly release: string;
    readonly debug: boolean;
    readonly plan: PlanTier;
    readonly planFeatures: PlanFeatures;
    readonly enableErrors: boolean;
    readonly enablePerformance: boolean;
    readonly enableTracing: boolean;
    readonly enableMetrics: boolean;
    readonly samplingRate: number;
    readonly maxBreadcrumbs: number;
    readonly maxQueueSize: number;
    readonly shutdownTimeoutMs: number;
    readonly ingestUrl: string;
    readonly batchSize: number;
    readonly flushIntervalMs: number;
    readonly maxRetries: number;
    readonly timeoutMs: number;
    readonly compression: 'gzip' | 'brotli' | 'none';
    readonly maxPayloadBytes: number;
    readonly maxConcurrentSends: number;
    readonly dataScrubbing: {
        sensitiveHeaders: string[];
        sensitiveKeys: string[];
        redactRequestBody: boolean;
        redactResponseBody: boolean;
    };
    readonly otelMetrics: {
        maxHistogramBuckets: number;
        percentiles: number[];
        cardinalityLimit: number;
    };
    readonly remoteConfig?: RemoteConfigResponse | undefined;
}
export declare const sdkInitOptionsSchema: z.ZodObject<{
    apiKey: z.ZodString;
    service: z.ZodOptional<z.ZodString>;
    environment: z.ZodOptional<z.ZodString>;
    release: z.ZodOptional<z.ZodString>;
    enableErrors: z.ZodOptional<z.ZodBoolean>;
    enablePerformance: z.ZodOptional<z.ZodBoolean>;
    enableTracing: z.ZodOptional<z.ZodBoolean>;
    enableMetrics: z.ZodOptional<z.ZodBoolean>;
    sampleRate: z.ZodOptional<z.ZodNumber>;
    maxBreadcrumbs: z.ZodOptional<z.ZodNumber>;
    plugins: z.ZodOptional<z.ZodReadonly<z.ZodArray<z.ZodCustom<SDKPlugin, SDKPlugin>>>>;
    eventProcessors: z.ZodOptional<z.ZodReadonly<z.ZodArray<z.ZodCustom<EventProcessor, EventProcessor>>>>;
    beforeBreadcrumb: z.ZodOptional<z.ZodCustom<BreadcrumbProcessor, BreadcrumbProcessor>>;
    beforeSend: z.ZodOptional<z.ZodCustom<(event: Record<string, unknown>) => Record<string, unknown> | null | Promise<Record<string, unknown> | null>, (event: Record<string, unknown>) => Record<string, unknown> | null | Promise<Record<string, unknown> | null>>>;
    debug: z.ZodOptional<z.ZodBoolean>;
    logLevel: z.ZodOptional<z.ZodEnum<{
        debug: "debug";
        info: "info";
        warning: "warning";
        error: "error";
        fatal: "fatal";
    }>>;
    baseUrl: z.ZodOptional<z.ZodString>;
    configUrl: z.ZodOptional<z.ZodString>;
    shutdownTimeoutMs: z.ZodOptional<z.ZodNumber>;
    sourceMaps: z.ZodOptional<z.ZodObject<{
        paths: z.ZodOptional<z.ZodReadonly<z.ZodArray<z.ZodString>>>;
        allowRemote: z.ZodOptional<z.ZodBoolean>;
        embedSourceContent: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
    dataScrubbing: z.ZodOptional<z.ZodObject<{
        sensitiveHeaders: z.ZodOptional<z.ZodReadonly<z.ZodArray<z.ZodString>>>;
        sensitiveKeys: z.ZodOptional<z.ZodReadonly<z.ZodArray<z.ZodString>>>;
        redactRequestBody: z.ZodOptional<z.ZodBoolean>;
        redactResponseBody: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
    transport: z.ZodOptional<z.ZodObject<{
        batchSize: z.ZodOptional<z.ZodNumber>;
        flushIntervalMs: z.ZodOptional<z.ZodNumber>;
        maxRetries: z.ZodOptional<z.ZodNumber>;
        timeoutMs: z.ZodOptional<z.ZodNumber>;
        compression: z.ZodOptional<z.ZodEnum<{
            gzip: "gzip";
            brotli: "brotli";
            none: "none";
        }>>;
        maxPayloadBytes: z.ZodOptional<z.ZodNumber>;
        maxConcurrentSends: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>;
}, z.core.$strict>;
//# sourceMappingURL=config.d.ts.map