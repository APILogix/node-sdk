import { z } from 'zod';
import type { SDKPlugin, EventProcessor, BreadcrumbProcessor } from './plugin.js';
import type { SeverityLevel } from './severity.js';
/**
 * Plan tier determines which SDK features are available.
 * Controlled by the backend — the SDK cannot override plan limits.
 */
export type PlanTier = 'free' | 'pro' | 'enterprise';
/**
 * Feature gates and limits for a plan.
 * The backend sends these alongside the remote config.
 * The SDK uses these to cap/clamp user-provided overrides.
 */
export interface PlanFeatures {
    /** Plan tier name. */
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
/**
 * Options passed to `createSDK()` or `init()`.
 * All fields except `apiKey` are optional — features are ON by default,
 * gated by the project's plan tier from the backend.
 */
export interface SDKInitOptions {
    /** Required. Project API key for authentication. */
    readonly apiKey: string;
    /** Service/application name (e.g. "payments-service"). Defaults to "unknown-service". */
    readonly service?: string;
    /** Deployment environment (e.g. "production", "staging"). Defaults to "production". */
    readonly environment?: string;
    /** Release/version identifier (e.g. "1.4.2", git SHA). Defaults to "0.0.0-unknown". */
    readonly release?: string;
    /** Enable/disable error tracking. Default: ON if plan allows. */
    readonly enableErrors?: boolean;
    /** Enable/disable performance (request) tracking. Default: ON if plan allows. */
    readonly enablePerformance?: boolean;
    /** Enable/disable tracing via OpenTelemetry. Default: ON if plan allows. */
    readonly enableTracing?: boolean;
    /** Enable/disable metrics collection. Default: ON if plan allows. */
    readonly enableMetrics?: boolean;
    /** Client-side sampling rate override (0.0–1.0). Only available on pro+ plans. */
    readonly sampleRate?: number;
    /** Maximum breadcrumbs to retain in the ring buffer. Capped by plan limits. */
    readonly maxBreadcrumbs?: number;
    /** Plugins to register during initialization. Plugin count capped by plan. */
    readonly plugins?: readonly SDKPlugin[];
    /** Event processors applied to every event before queuing. */
    readonly eventProcessors?: readonly EventProcessor[];
    /** Breadcrumb processor — return null to drop a breadcrumb. */
    readonly beforeBreadcrumb?: BreadcrumbProcessor;
    /** Called before every event is sent — return null to drop. Pro+ plans only. */
    readonly beforeSend?: (event: Record<string, unknown>) => Record<string, unknown> | null;
    /** Transport configuration overrides. */
    readonly transport?: TransportOptions;
    /** Enable SDK debug mode — verbose console.log output. Defaults to false. */
    readonly debug?: boolean;
    /** Minimum severity level for SDK internal logging. Defaults to 'warning'. */
    readonly logLevel?: SeverityLevel;
    /** Custom server base URL override. Uses SDK_BASE_URL env var or default. */
    readonly baseUrl?: string;
    /** Graceful shutdown timeout in milliseconds. Defaults to 10000. */
    readonly shutdownTimeoutMs?: number;
}
/**
 * Transport configuration — controls batching, retries, compression.
 */
export interface TransportOptions {
    /** Maximum events per batch. Capped by plan limit. */
    readonly batchSize?: number;
    /** Flush interval in milliseconds. */
    readonly flushIntervalMs?: number;
    /** Maximum retry attempts for failed sends. */
    readonly maxRetries?: number;
    /** Request timeout in milliseconds. */
    readonly timeoutMs?: number;
    /** Enable payload compression ('gzip' | 'brotli' | 'none'). Availability depends on plan. */
    readonly compression?: 'gzip' | 'brotli' | 'none';
    /** Maximum payload size in bytes. */
    readonly maxPayloadBytes?: number;
    /** Maximum concurrent in-flight batch sends. */
    readonly maxConcurrentSends?: number;
}
/**
 * Configuration returned by the /v1/init endpoint.
 * This is the server's view of how this project should behave.
 * Now includes plan tier and feature gates.
 */
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
    /** Plan tier for this project. Defaults to 'free' if not provided. */
    readonly plan?: PlanTier | undefined;
    /** Plan-specific feature gates. Built from defaults if not provided. */
    readonly planFeatures?: Partial<PlanFeatures> | undefined;
}
/**
 * Fully resolved configuration — merges user options with remote config,
 * then clamps to plan limits. This is the internal source of truth.
 */
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
    beforeSend: z.ZodOptional<z.ZodCustom<(event: Record<string, unknown>) => Record<string, unknown> | null, (event: Record<string, unknown>) => Record<string, unknown> | null>>;
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