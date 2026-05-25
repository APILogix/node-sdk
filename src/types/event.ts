import type { SeverityLevel } from './severity.js'
import type { Breadcrumb } from './breadcrumb.js'

// ─── Stack Frame ────────────────────────────────────────────────────────────

export interface StackFrame {
  readonly filename: string
  readonly function: string
  readonly lineno?: number | undefined
  readonly colno?: number | undefined
  readonly inApp: boolean
  readonly module?: string | undefined
  readonly sourceContext?: {
    readonly pre: readonly string[]
    readonly line: string
    readonly post: readonly string[]
  } | undefined
}

// ─── Event Types ────────────────────────────────────────────────────────────

/** Metadata attached to every event automatically by the SDK. */
export interface EventMetadata {
  readonly sdkName: string
  readonly sdkVersion: string
  readonly service: string
  readonly environment: string
  readonly release: string
  readonly serverName?: string
}

export interface RequestEvent {
  readonly type: 'request'
  eventId?: string
  readonly requestId: string
  readonly url: string
  readonly method: string
  readonly statusCode: number
  readonly latency: number
  readonly timestamp: number
  readonly headers?: Readonly<Record<string, unknown>> | undefined
  readonly query?: Readonly<Record<string, unknown>> | undefined
  readonly body?: Readonly<Record<string, unknown>> | undefined
  readonly bodySize?: number | undefined
  readonly responseSize?: number | undefined
  readonly userId?: string | null | undefined
  readonly tenantId?: string | undefined
  readonly sessionId?: string | undefined
  readonly clientIp?: string | undefined
  readonly userAgent?: string | undefined
  readonly referer?: string | undefined
  readonly route?: string | undefined
  readonly traceId?: string | undefined
  readonly spanId?: string | undefined
  readonly metadata?: EventMetadata | undefined
}

export interface ErrorEvent {
  readonly type: 'error'
  eventId?: string
  readonly requestId?: string | undefined
  readonly message: string
  readonly name: string
  readonly stack: readonly StackFrame[]
  readonly fingerprint: string
  readonly timestamp: number
  readonly severity: SeverityLevel
  readonly context: Readonly<Record<string, unknown>>
  readonly breadcrumbs?: readonly Breadcrumb[] | undefined
  readonly traceId?: string | undefined
  readonly spanId?: string | undefined
  readonly metadata?: EventMetadata | undefined
}

export interface MessageEvent {
  readonly type: 'message'
  eventId?: string
  readonly message: string
  readonly severity: SeverityLevel
  readonly timestamp: number
  readonly context?: Readonly<Record<string, unknown>> | undefined
  readonly breadcrumbs?: readonly Breadcrumb[] | undefined
  readonly traceId?: string | undefined
  readonly spanId?: string | undefined
  readonly metadata?: EventMetadata | undefined
}

export type MetricType = 'counter' | 'gauge' | 'histogram'

export interface MetricEvent {
  readonly type: 'metric'
  eventId?: string
  readonly metricName: string
  readonly metricType: MetricType
  readonly value: number
  readonly unit?: string | undefined
  readonly tags?: Readonly<Record<string, string>> | undefined
  readonly timestamp: number
  readonly metadata?: EventMetadata | undefined
  readonly count?: number | undefined
  readonly sum?: number | undefined
  readonly min?: number | undefined
  readonly max?: number | undefined
  readonly p50?: number | undefined
  readonly p75?: number | undefined
  readonly p90?: number | undefined
  readonly p95?: number | undefined
  readonly p99?: number | undefined
  readonly avg?: number | undefined
  readonly rate?: number | undefined
}

export interface SpanEventItem {
  readonly name: string
  readonly timestamp: number
  readonly attributes?: Readonly<Record<string, unknown>> | undefined
}

export interface SpanLink {
  readonly traceId: string
  readonly spanId: string
}

export interface SpanEvent {
  readonly type: 'span'
  eventId?: string
  readonly timestamp?: number
  readonly requestId?: string | undefined
  readonly sessionId?: string | undefined
  readonly userId?: string | undefined
  readonly tenantId?: string | undefined
  readonly spanId: string
  readonly traceId: string
  readonly parentSpanId?: string | undefined
  readonly name: string
  readonly startTime: number
  readonly endTime: number
  readonly duration: number
  readonly status: 'ok' | 'error' | 'unset'
  readonly statusMessage?: string | undefined
  readonly attributes?: Readonly<Record<string, unknown>> | undefined
  readonly events?: readonly SpanEventItem[] | undefined
  readonly links?: readonly SpanLink[] | undefined
  readonly metadata?: EventMetadata | undefined
}

// ─── New Event Types (Remote Config Driven) ─────────────────────────────────

/** Log event captured from console interception or explicit API. */
export interface LogEvent {
  readonly type: 'log'
  eventId?: string
  readonly level: string
  readonly message: string
  readonly timestamp: number
  readonly args?: readonly unknown[] | undefined
  readonly requestId?: string | undefined
  readonly traceId?: string | undefined
  readonly spanId?: string | undefined
  readonly metadata?: EventMetadata | undefined
}

/** Profiling event containing CPU or heap profile data. */
export interface ProfileEvent {
  readonly type: 'profile'
  eventId?: string
  readonly profileType: 'cpu' | 'heap'
  readonly requestId?: string | undefined
  readonly traceId?: string | undefined
  readonly spanId?: string | undefined
  readonly startTime: number
  readonly endTime: number
  readonly duration: number
  readonly profile: unknown
  readonly timestamp: number
  readonly metadata?: EventMetadata | undefined
}

/** Session replay event containing recorded DOM mutations. */
export interface ReplayEvent {
  readonly type: 'replay'
  eventId?: string
  readonly sessionId: string
  readonly segmentId: number
  readonly timestamp: number
  readonly events: readonly unknown[]
  readonly metadata?: EventMetadata | undefined
}

/** Cron check-in event for monitoring scheduled jobs. */
export interface CronCheckInEvent {
  readonly type: 'cron_checkin'
  eventId?: string
  readonly monitorSlug: string
  readonly status: 'ok' | 'error' | 'in_progress'
  readonly timestamp: number
  readonly duration?: number | undefined
  readonly environment?: string | undefined
  readonly metadata?: EventMetadata | undefined
}

// ─── Discriminated Union ────────────────────────────────────────────────────

/** Discriminated union of all event types. */
export type SDKEvent =
  | RequestEvent
  | ErrorEvent
  | MessageEvent
  | MetricEvent
  | SpanEvent
  | LogEvent
  | ProfileEvent
  | ReplayEvent
  | CronCheckInEvent

/**
 * Legacy compat — the old Event type. Use SDKEvent for new code.
 * @deprecated Use SDKEvent instead.
 */
export type Event = SDKEvent | (Record<string, unknown> & { eventId?: string })
