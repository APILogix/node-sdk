import { z } from 'zod';
import type { SDKPlugin, EventProcessor, BreadcrumbProcessor } from './plugin.js';
import type { SeverityLevel } from './severity.js';
/** Bumped on incompatible schema changes. SDKs reject configs with a higher major. */
export declare const REMOTE_CONFIG_SCHEMA_VERSION = 1;
/**
 * Top-level normalized remote configuration snapshot.
 * Represents the authoritative, fully validated, and deep-frozen state of the SDK.
 */
export interface NormalizedRemoteConfig {
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
    readonly offlineQueue?: OfflineQueueConfig | undefined;
    readonly profiling?: ProfilingConfig | undefined;
    readonly replay?: SessionReplayConfig | undefined;
    readonly errors?: ErrorsConfig | undefined;
    readonly tracing?: TracingConfig | undefined;
    readonly metrics?: MetricsConfig | undefined;
    readonly logs?: LogsConfig | undefined;
    readonly crons?: CronsConfig | undefined;
}
/** Backward-compatibility alias */
export type RemoteConfigResponse = NormalizedRemoteConfig;
/** Wire shape prior to validation and normalization */
export type RawRemoteConfig = Record<string, unknown>;
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
    readonly adaptiveSampling?: boolean | undefined;
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
    readonly traces?: number | undefined;
    readonly requests?: number | undefined;
    readonly spans?: number | undefined;
    readonly errors?: number | undefined;
    readonly messages?: number | undefined;
    readonly profiles?: number | undefined;
    readonly replays?: number | undefined;
    readonly metrics?: number | undefined;
    readonly logs?: number | undefined;
    readonly events?: number | undefined;
    readonly crons?: number | undefined;
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
    readonly adaptive?: boolean | undefined;
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
    readonly redis: RedisInstrumentationConfig | boolean;
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
    readonly emitCreateSpansForBulk?: boolean | undefined;
    /** Emit per-job spans for `FlowProducer.add` / `addBulk`. Default: true. */
    readonly emitCreateSpansForFlow?: boolean | undefined;
    /** Only create producer spans when a parent span is active. Default: false. */
    readonly requireParentSpanForPublish?: boolean | undefined;
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
export interface RedisInstrumentationConfig {
    readonly enabled: boolean;
    readonly keyPolicy?: 'command-only' | 'sanitized-key' | 'full' | 'hash';
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
    readonly maskCreditCards?: boolean;
    readonly maskSSNs?: boolean;
}
export type MemoryLimit = number | 'auto';
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
export interface PersistenceGovernanceConfig {
    /** Maximum non-critical events persisted to disk per rolling minute. */
    readonly maxPersistPerMinute: number;
    /** Whether memory/queue/GC/event-loop pressure should reduce non-critical persistence. */
    readonly adaptive: boolean;
    /** Minimum interval between aggregated budget-exceeded SDK warnings. */
    readonly budgetExceededLogIntervalMs: number;
}
export interface LimitsConfig {
    readonly maxSpansPerTrace: number;
    readonly maxSpanAttributes: number;
    readonly maxAttributeLength: number;
    readonly maxPayloadSize: number;
    readonly maxQueueSize: number;
    readonly maxMemoryMb: MemoryLimit;
    readonly tenantGovernance: TenantGovernanceConfig;
    readonly persistenceGovernance: PersistenceGovernanceConfig;
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
export interface OfflineQueueConfig {
    readonly enabled: boolean;
    readonly maxFileSizeBytes: number;
    readonly maxEvents: number;
    readonly eventTtlMs: number;
    readonly ioTimeoutMs: number;
    readonly flushDebounceMs?: number | undefined;
}
export interface OfflineQueueInitOptions {
    readonly enabled?: boolean | undefined;
    readonly directory?: string | undefined;
    readonly maxFileSizeBytes?: number | undefined;
    readonly maxEvents?: number | undefined;
    readonly eventTtlMs?: number | undefined;
    readonly ioTimeoutMs?: number | undefined;
    readonly flushDebounceMs?: number | undefined;
}
export interface ProfilingConfig {
    readonly enabled: boolean;
    readonly cpu: boolean;
    readonly heap: boolean;
    readonly sampleRate: number;
    readonly maxDurationMs: number;
    readonly sampleIntervalMicroseconds?: number | undefined;
    readonly continuous?: boolean | undefined;
    readonly continuousIntervalMs?: number | undefined;
    readonly sampleRateHz?: number | undefined;
}
export interface SessionReplayConfig {
    readonly enabled: boolean;
    readonly sampleRate: number;
    readonly idleTimeoutMs: number;
    readonly maxDurationMs: number;
    readonly maxBufferSize?: number | undefined;
    readonly maskAllInputs?: boolean | undefined;
}
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
export interface TracingConfig {
    readonly maxSpansPerTrace: number;
    readonly maxSpanAttributes: number;
    readonly maxTraceDurationMs: number;
    readonly propagation: {
        readonly w3c: boolean;
        readonly baggage: boolean;
        readonly b3: boolean;
    };
}
export interface MetricsConfig {
    readonly runtimeMetrics: boolean;
    readonly eventLoopMonitoring: boolean;
    readonly gcMonitoring: boolean;
    readonly pushIntervalMs: number;
    readonly cardinalityLimit: number;
}
export interface LogsConfig {
    readonly enabled: boolean;
    readonly captureConsole: boolean;
    readonly levels: readonly string[];
    readonly maxLogSize: number;
}
export interface CronsConfig {
    readonly enabled: boolean;
    readonly checkInMarginMs: number;
    readonly timeoutMs: number;
}
/**
 * Per-event-type ingestion routes. The set of route names is fixed by the
 * SDK contract — adding a new event type requires an SDK release.
 */
export type TransportRouteName = 'traces' | 'requests' | 'spans' | 'errors' | 'metrics' | 'logs' | 'profiles' | 'events' | 'crons' | 'replays';
export type CompressionType = 'gzip' | 'none';
export type RoutePriority = 'critical' | 'high' | 'normal' | 'low';
export type OverflowStrategy = 'drop_oldest' | 'drop_newest';
export type BackoffStrategy = 'exponential' | 'linear' | 'fixed';
export declare enum ConfigState {
    Pending = "pending",
    Live = "live",
    Fallback = "fallback",
    Destroyed = "destroyed"
}
export interface TransportRouteConfig {
    readonly url: string;
    readonly batchSize: number;
    readonly flushIntervalMs: number;
    readonly timeoutMs: number;
    readonly compression: CompressionType;
    /** Internal scheduling priority. */
    readonly priority: RoutePriority;
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
    readonly maxConnectionsPerRoute?: Partial<Readonly<Record<TransportRouteName, number>>> | undefined;
    readonly acquireTimeoutMs: number;
}
export interface TransportRetryConfig {
    readonly enabled: boolean;
    readonly maxRetries: number;
    readonly backoff: BackoffStrategy;
    readonly baseDelayMs: number;
}
export interface TransportQueueConfig {
    readonly overflowStrategy: OverflowStrategy;
    /** Per-route queue cap; also bounded by limits.maxQueueSize. */
    readonly maxSize: number;
    /** Slots protected from non-critical telemetry. */
    readonly criticalReserve: number;
}
export interface ConfigMeta {
    readonly generatedAt: string;
    readonly generatedBy: string;
    readonly configHash?: string | undefined;
    readonly configRevision?: number | null | undefined;
}
/**
 * Detailed descriptor for a single leaf or structured property mutation.
 */
export interface FieldChange {
    /** Dot-delimited canonical path, e.g. "features.profiling", "transport.routes.errors.batchSize" */
    readonly path: string;
    /** Value in the previous configuration snapshot (undefined if newly added) */
    readonly previousValue: unknown;
    /** Value in the incoming configuration snapshot (undefined if removed) */
    readonly nextValue: unknown;
    /** Classification of the mutation */
    readonly type: 'added' | 'removed' | 'modified';
}
/**
 * Result of diffing two NormalizedRemoteConfig (or RemoteConfigResponse) snapshots.
 */
export interface ConfigDiff {
    /** True if any semantic configuration change exists (ignoring benign meta timestamp updates) */
    readonly hasChanges: boolean;
    readonly sdkChanged: boolean;
    readonly featuresChanged: boolean;
    readonly killswitchesChanged: boolean;
    readonly samplingChanged: boolean;
    readonly transportChanged: boolean;
    readonly privacyChanged: boolean;
    readonly limitsChanged: boolean;
    readonly instrumentationChanged: boolean;
    readonly entitlementsChanged: boolean;
    readonly profilingChanged: boolean;
    readonly replayChanged: boolean;
    readonly tracingChanged: boolean;
    readonly metricsChanged: boolean;
    readonly loggingChanged: boolean;
    readonly errorsChanged: boolean;
    readonly offlineQueueChanged?: boolean | undefined;
    readonly logsChanged?: boolean | undefined;
    readonly cronsChanged?: boolean | undefined;
    readonly errorsSectionChanged?: boolean | undefined;
    readonly tracingSectionChanged?: boolean | undefined;
    readonly metricsSectionChanged?: boolean | undefined;
    readonly changes: ReadonlyMap<string, {
        old: unknown;
        new: unknown;
        changeType?: 'added' | 'removed' | 'modified' | undefined;
    }>;
    readonly addedKeys: readonly string[];
    readonly removedKeys: readonly string[];
    readonly modifiedKeys: readonly string[];
    readonly fieldChanges: readonly FieldChange[];
}
export declare function isNormalizedRemoteConfig(value: unknown): value is NormalizedRemoteConfig;
export declare function isRawRemoteConfig(value: unknown): value is RawRemoteConfig;
export declare function isTransportRouteName(name: string): name is TransportRouteName;
export declare function isCompressionType(comp: string): comp is CompressionType;
export declare function isRoutePriority(prio: string): prio is RoutePriority;
export declare function isOverflowStrategy(strat: string): strat is OverflowStrategy;
export declare function isBackoffStrategy(strat: string): strat is BackoffStrategy;
export declare function isMemoryLimit(mem: unknown): mem is MemoryLimit;
/**
 * Local integration options. Runtime telemetry policy is intentionally absent:
 * identity, features, sampling, privacy, limits, transport, instrumentation,
 * killswitches, and entitlements come only from remote config.
 */
export interface SDKInitOptions {
    readonly apiKey: string;
    /** Startup request deadline in milliseconds (default: 3000). Failure leaves telemetry disabled. */
    readonly initTimeoutMs?: number | undefined;
    /**
     * Number of retries for transient /v1/init failures (default: 2). The
     * complete attempt sequence remains within initTimeoutMs.
     */
    readonly initRetries?: number | undefined;
    /** Whether to automatically register SIGTERM/SIGINT listeners for graceful shutdown (default: true). */
    readonly handleSignals?: boolean | undefined;
    readonly applicationName?: string | undefined;
    readonly applicationVersion?: string | undefined;
    readonly packageJsonPath?: string | undefined;
    readonly plugins?: readonly SDKPlugin[] | undefined;
    readonly eventProcessors?: readonly EventProcessor[] | undefined;
    readonly beforeBreadcrumb?: BreadcrumbProcessor | undefined;
    readonly beforeSend?: ((event: Record<string, unknown>) => Record<string, unknown> | null | Promise<Record<string, unknown> | null>) | undefined;
    readonly debug?: boolean | undefined;
    readonly logLevel?: SeverityLevel | undefined;
    readonly shutdownTimeoutMs?: number | undefined;
    /**
     * Whether to terminate the process after an uncaughtException once telemetry flush
     * has completed or timed out (default: true). Set to false for custom crash supervisors or test environments.
     */
    readonly exitOnUncaughtException?: boolean | undefined;
    /**
     * Maximum time in milliseconds to wait for crash telemetry to flush before process termination (default: 2000).
     */
    readonly crashTimeoutMs?: number | undefined;
    /**
     * Optional callback invoked right before process termination on uncaughtException.
     */
    readonly onFatalError?: ((error: Error) => void) | undefined;
    readonly sourceMaps?: {
        readonly paths?: readonly string[] | undefined;
        readonly allowRemote?: boolean | undefined;
        readonly embedSourceContent?: boolean | undefined;
    } | undefined;
    /**
     * Offline queue / persistent storage configuration.
     * Pass `false` to completely disable disk persistence (recommended for purely ephemeral/stateless serverless runtimes).
     */
    readonly offlineQueue?: boolean | OfflineQueueInitOptions | undefined;
}
export declare const sdkInitOptionsSchema: z.ZodObject<{
    apiKey: z.ZodString;
    initTimeoutMs: z.ZodOptional<z.ZodNumber>;
    initRetries: z.ZodOptional<z.ZodNumber>;
    handleSignals: z.ZodOptional<z.ZodBoolean>;
    applicationName: z.ZodOptional<z.ZodString>;
    applicationVersion: z.ZodOptional<z.ZodString>;
    packageJsonPath: z.ZodOptional<z.ZodString>;
    plugins: z.ZodOptional<z.ZodReadonly<z.ZodArray<z.ZodCustom<SDKPlugin, SDKPlugin>>>>;
    eventProcessors: z.ZodOptional<z.ZodReadonly<z.ZodArray<z.ZodCustom<EventProcessor, EventProcessor>>>>;
    beforeBreadcrumb: z.ZodOptional<z.ZodCustom<BreadcrumbProcessor, BreadcrumbProcessor>>;
    beforeSend: z.ZodOptional<z.ZodCustom<(event: Record<string, unknown>) => Record<string, unknown> | null | Promise<Record<string, unknown> | null>, (event: Record<string, unknown>) => Record<string, unknown> | null | Promise<Record<string, unknown> | null>>>;
    debug: z.ZodOptional<z.ZodBoolean>;
    logLevel: z.ZodOptional<z.ZodEnum<{
        debug: "debug";
        error: "error";
        fatal: "fatal";
        info: "info";
        warning: "warning";
    }>>;
    shutdownTimeoutMs: z.ZodOptional<z.ZodNumber>;
    exitOnUncaughtException: z.ZodOptional<z.ZodBoolean>;
    crashTimeoutMs: z.ZodOptional<z.ZodNumber>;
    onFatalError: z.ZodOptional<z.ZodCustom<(error: Error) => void, (error: Error) => void>>;
    sourceMaps: z.ZodOptional<z.ZodObject<{
        paths: z.ZodOptional<z.ZodReadonly<z.ZodArray<z.ZodString>>>;
        allowRemote: z.ZodOptional<z.ZodBoolean>;
        embedSourceContent: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>>;
    offlineQueue: z.ZodOptional<z.ZodUnion<readonly [z.ZodBoolean, z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
        directory: z.ZodOptional<z.ZodString>;
        maxFileSizeBytes: z.ZodOptional<z.ZodNumber>;
        maxEvents: z.ZodOptional<z.ZodNumber>;
        eventTtlMs: z.ZodOptional<z.ZodNumber>;
        ioTimeoutMs: z.ZodOptional<z.ZodNumber>;
        flushDebounceMs: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>]>>;
}, z.core.$strict>;
