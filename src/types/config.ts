import { z } from 'zod'
import type { SDKPlugin, EventProcessor, BreadcrumbProcessor } from './plugin.js'
import type { SeverityLevel } from './severity.js'

// ─── SDK Init Options (user-facing) ─────────────────────────────────────────

/**
 * Options passed to `createSDK()` or `init()`.
 * All fields except `apiKey` are optional with sensible defaults.
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

  /** Enable/disable error tracking. Defaults to true. */
  readonly enableErrors?: boolean

  /** Enable/disable performance (request) tracking. Defaults to true. */
  readonly enablePerformance?: boolean

  /** Enable/disable tracing via OpenTelemetry. Defaults to false. */
  readonly enableTracing?: boolean

  /** Enable/disable metrics collection. Defaults to false. */
  readonly enableMetrics?: boolean

  /** Client-side sampling rate override (0.0–1.0). Server config takes precedence. */
  readonly sampleRate?: number

  /** Maximum breadcrumbs to retain in the ring buffer. Defaults to 100. */
  readonly maxBreadcrumbs?: number

  /** Plugins to register during initialization. */
  readonly plugins?: readonly SDKPlugin[]

  /** Event processors applied to every event before queuing. */
  readonly eventProcessors?: readonly EventProcessor[]

  /** Breadcrumb processor — return null to drop a breadcrumb. */
  readonly beforeBreadcrumb?: BreadcrumbProcessor

  /** Called before every event is sent — return null to drop. */
  readonly beforeSend?: (event: Record<string, unknown>) => Record<string, unknown> | null

  /** Transport configuration overrides. */
  readonly transport?: TransportOptions

  /** Enable SDK debug mode — verbose console.log output. Defaults to false. */
  readonly debug?: boolean

  /** Minimum severity level for SDK internal logging. Defaults to 'warning'. */
  readonly logLevel?: SeverityLevel

  /** Custom server base URL override. Uses SDK_BASE_URL env var or default. */
  readonly baseUrl?: string

  /** Graceful shutdown timeout in milliseconds. Defaults to 10000. */
  readonly shutdownTimeoutMs?: number
}

/**
 * Transport configuration — controls batching, retries, compression.
 */
export interface TransportOptions {
  /** Maximum events per batch. */
  readonly batchSize?: number
  /** Flush interval in milliseconds. */
  readonly flushIntervalMs?: number
  /** Maximum retry attempts for failed sends. */
  readonly maxRetries?: number
  /** Request timeout in milliseconds. */
  readonly timeoutMs?: number
  /** Enable payload compression ('gzip' | 'none'). Defaults to 'gzip'. */
  readonly compression?: 'gzip' | 'brotli' | 'none'
  /** Maximum payload size in bytes. */
  readonly maxPayloadBytes?: number
  /** Maximum concurrent in-flight batch sends. */
  readonly maxConcurrentSends?: number
}

// ─── Remote Config (server-provided) ────────────────────────────────────────

/**
 * Configuration returned by the /v1/init endpoint.
 * This is the server's view of how this project should behave.
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
}

// ─── Resolved Config (merged) ───────────────────────────────────────────────

/**
 * Fully resolved configuration — merges user options with remote config.
 * This is the internal source of truth after initialization.
 */
export interface ResolvedSDKConfig {
  readonly apiKey: string
  readonly service: string
  readonly environment: string
  readonly release: string
  readonly debug: boolean

  // Feature flags
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
  debug: z.boolean().optional(),
  baseUrl: z.string().url().optional(),
  shutdownTimeoutMs: z.number().int().min(1000).max(60000).optional(),
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
