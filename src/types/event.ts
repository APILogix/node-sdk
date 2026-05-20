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
  readonly bodySize?: number | undefined
  readonly userId?: string | null | undefined
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
  readonly spanId: string
  readonly traceId: string
  readonly parentSpanId?: string | undefined
  readonly name: string
  readonly startTime: number
  readonly endTime: number
  readonly duration: number
  readonly status: 'ok' | 'error' | 'unset'
  readonly attributes?: Readonly<Record<string, unknown>> | undefined
  readonly events?: readonly SpanEventItem[] | undefined
  readonly links?: readonly SpanLink[] | undefined
  readonly metadata?: EventMetadata | undefined
}

/** Discriminated union of all event types. */
export type SDKEvent = RequestEvent | ErrorEvent | MessageEvent | MetricEvent | SpanEvent

/**
 * Legacy compat — the old Event type. Use SDKEvent for new code.
 * @deprecated Use SDKEvent instead.
 */
export type Event = SDKEvent | (Record<string, unknown> & { eventId?: string })
