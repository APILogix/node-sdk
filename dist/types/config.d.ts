import { z } from 'zod';
import type { SDKPlugin, EventProcessor, BreadcrumbProcessor } from './plugin.js';
import type { SeverityLevel } from './severity.js';
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
    readonly meta: ConfigMeta;
    /** Billing and API entitlements resolved by the backend. */
    readonly entitlements: EntitlementsConfig;
}
export interface SdkIdentityConfig {
    readonly projectId: string;
    /** Backend-owned service identity. Falls back to projectId when omitted. */
    readonly service?: string | undefined;
    readonly environment: string;
    readonly release: string;
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
    readonly spans?: number;
    readonly errors?: number;
    readonly messages?: number;
    readonly profiles?: number;
    readonly replays?: number;
    readonly metrics?: number;
    readonly logs?: number;
    readonly events?: number;
    readonly crons?: number;
}
export interface SamplingConfig {
    readonly traces: number;
    readonly requests: number;
    readonly spans: number;
    readonly errors: number;
    readonly messages: number;
    readonly profiles: number;
    readonly replays: number;
    readonly metrics: number;
    readonly logs: number;
    readonly events: number;
    readonly crons: number;
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
    readonly bullmq: BullMQInstrumentationConfig | boolean;
    readonly pg: PgInstrumentationConfig | boolean;
    readonly mysql2: MySQLInstrumentationConfig | boolean;
    readonly eventEmitterPatch: boolean;
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
export interface BullMQInstrumentationConfig {
    readonly enabled: boolean;
    /** Emit per-job spans for `Queue.addBulk` / `FlowProducer.addBulk`. Default: true. */
    readonly emitCreateSpansForBulk?: boolean;
    /** Emit per-job spans for `FlowProducer.add` / `addBulk`. Default: true. */
    readonly emitCreateSpansForFlow?: boolean;
    /** Only create producer spans when a parent span is active. Default: false. */
    readonly requireParentSpanForPublish?: boolean;
}
export interface PgInstrumentationConfig {
    readonly enabled: boolean;
    readonly captureQueries: boolean;
    readonly captureParams: boolean;
}
export interface MySQLInstrumentationConfig {
    readonly enabled: boolean;
    readonly captureQueries: boolean;
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
 * sets the values; snapshots outside the SDK safety bounds are rejected as a
 * whole before any active configuration is replaced.
 */
export interface TenantGovernanceConfig {
    readonly enabled: boolean;
    readonly maxTenantsTracked: number;
    readonly quotaPerWindow: number;
    readonly windowDurationMs: number;
    /** Additional high-priority/fatal events accepted after normal quota. */
    readonly criticalReserve: number;
}
export interface LimitsConfig {
    readonly maxSpansPerTrace: number;
    readonly maxSpanAttributes: number;
    readonly maxAttributeLength: number;
    readonly maxPayloadSize: number;
    readonly maxQueueSize: number;
    readonly maxMemoryMb: number | 'auto';
    readonly tenantGovernance: TenantGovernanceConfig;
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
 * Billing/plan entitlements sent by the control plane. Optional developer APIs
 * use their family gate, while requestCapture/tracing/errors/metrics govern
 * corresponding automatic telemetry paths. Core manual error/message capture,
 * local scope/context, flush, and shutdown remain ungated.
 */
export interface EntitlementsConfig {
    /** `startSpan()` / `withSpan()` / `withSpanSync()` custom tracing APIs. */
    readonly customSpans: boolean;
    /** `counter()` / `gauge()` / `histogram()` and friends. */
    readonly customMetrics: boolean;
    /** `startProfile()` / `stopProfile()` and automatic CPU/heap profiling. */
    readonly profiling: boolean;
    /** `captureLog()` structured log capture. */
    readonly logging: boolean;
    /** `captureReplay()` session-replay segment capture. */
    readonly sessionReplay: boolean;
    /** `captureCronCheckIn()` cron monitoring check-ins. */
    readonly crons: boolean;
    /** Automatic incoming HTTP request capture. */
    readonly requestCapture: boolean;
    /** Automatic distributed tracing (HTTP/framework spans). */
    readonly tracing: boolean;
    /** Automatic error capture (uncaught, unhandled, console.error). */
    readonly errors: boolean;
    /** Automatic/runtime metrics collection. */
    readonly metrics: boolean;
}
/**
 * Per-event-type ingestion routes. The set of route names is fixed by the
 * SDK contract — adding a new event type requires an SDK release.
 */
export type TransportRouteName = 'traces' | 'requests' | 'spans' | 'errors' | 'metrics' | 'logs' | 'profiles' | 'events' | 'crons' | 'replays';
export interface TransportRouteConfig {
    readonly url: string;
    readonly batchSize: number;
    readonly flushIntervalMs: number;
    readonly timeoutMs: number;
    readonly compression: 'gzip' | 'none';
    /** Internal scheduling priority. */
    readonly priority: 'critical' | 'high' | 'normal' | 'low';
}
export interface TransportRemoteConfig {
    readonly retry: TransportRetryConfig;
    readonly queue: TransportQueueConfig;
    readonly connections: TransportConnectionConfig;
    readonly keepAlive: boolean;
    readonly routes: Readonly<Record<TransportRouteName, TransportRouteConfig>>;
}
export interface TransportConnectionConfig {
    readonly maxTotalConnections: number;
    readonly maxConnectionsPerRoute?: Partial<Readonly<Record<TransportRouteName, number>>>;
    readonly acquireTimeoutMs: number;
}
export interface TransportRetryConfig {
    readonly enabled: boolean;
    readonly maxRetries: number;
    readonly backoff: 'exponential' | 'linear' | 'fixed';
    readonly baseDelayMs: number;
}
export interface TransportQueueConfig {
    readonly overflowStrategy: 'drop_oldest' | 'drop_newest';
    /** Per-route queue cap; also bounded by limits.maxQueueSize. */
    readonly maxSize: number;
    /** Slots protected from non-critical telemetry. */
    readonly criticalReserve: number;
}
export interface ConfigMeta {
    readonly generatedAt: string;
    readonly generatedBy: string;
    readonly configHash?: string;
}
/** Result of diffing two RemoteConfigResponse objects. */
export interface ConfigDiff {
    readonly sdkChanged: boolean;
    readonly featuresChanged: boolean;
    readonly killswitchesChanged: boolean;
    readonly samplingChanged: boolean;
    readonly transportChanged: boolean;
    readonly privacyChanged: boolean;
    readonly limitsChanged: boolean;
    readonly instrumentationChanged: boolean;
    readonly entitlementsChanged: boolean;
    readonly changes: ReadonlyMap<string, {
        old: unknown;
        new: unknown;
    }>;
}
/**
 * Local integration options. Runtime telemetry policy is intentionally absent:
 * identity, features, sampling, privacy, limits, transport, instrumentation,
 * killswitches, and entitlements come only from remote config.
 */
export interface SDKInitOptions {
    readonly apiKey: string;
    readonly applicationName?: string;
    readonly applicationVersion?: string;
    readonly packageJsonPath?: string;
    readonly maxBreadcrumbs?: number;
    readonly plugins?: readonly SDKPlugin[];
    readonly eventProcessors?: readonly EventProcessor[];
    readonly beforeBreadcrumb?: BreadcrumbProcessor;
    readonly beforeSend?: (event: Record<string, unknown>) => Record<string, unknown> | null | Promise<Record<string, unknown> | null>;
    readonly debug?: boolean;
    readonly logLevel?: SeverityLevel;
    readonly baseUrl?: string;
    readonly shutdownTimeoutMs?: number;
    readonly sourceMaps?: {
        readonly paths?: readonly string[];
        readonly allowRemote?: boolean;
        readonly embedSourceContent?: boolean;
    };
}
export declare const sdkInitOptionsSchema: z.ZodObject<{
    apiKey: z.ZodString;
    applicationName: z.ZodOptional<z.ZodString>;
    applicationVersion: z.ZodOptional<z.ZodString>;
    packageJsonPath: z.ZodOptional<z.ZodString>;
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
    shutdownTimeoutMs: z.ZodOptional<z.ZodNumber>;
    sourceMaps: z.ZodOptional<z.ZodObject<{
        paths: z.ZodOptional<z.ZodReadonly<z.ZodArray<z.ZodString>>>;
        allowRemote: z.ZodOptional<z.ZodBoolean>;
        embedSourceContent: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>>;
}, z.core.$strict>;
//# sourceMappingURL=config.d.ts.map