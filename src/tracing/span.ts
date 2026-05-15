/**
 * Pulse SDK Span — wraps OpenTelemetry spans with SDK-specific enrichment.
 *
 * Provides:
 * - Automatic error recording with stack traces
 * - Attribute and event helpers
 * - Duration measurement
 * - Status management
 * - Integration with SDK context (breadcrumbs, user, tags)
 */

import {
  type Span as OTelSpan,
  SpanStatusCode,
  type Attributes,
  type TimeInput,
} from '@opentelemetry/api'
import { getLogger } from '../utils/logger.js'

export type SpanStatus = 'ok' | 'error' | 'unset'

export interface SpanOptions {
  /** Custom attributes to attach to the span at creation. */
  attributes?: Attributes
  /** Link this span to a parent span ID (manual linking). */
  parentSpanId?: string
  /** ISO timestamp to use as span start time. */
  startTime?: TimeInput
}

/**
 * PulseSpan wraps an OTel Span with ergonomic helpers.
 * Never throws — all operations are isolated.
 */
export class PulseSpan {
  private readonly otelSpan: OTelSpan
  private readonly logger = getLogger()
  private ended = false

  constructor(otelSpan: OTelSpan) {
    this.otelSpan = otelSpan
  }

  /** Get the span ID. */
  get spanId(): string {
    return this.otelSpan.spanContext().spanId
  }

  /** Get the trace ID. */
  get traceId(): string {
    return this.otelSpan.spanContext().traceId
  }

  /** Whether this span is still recording. */
  get isRecording(): boolean {
    return this.otelSpan.isRecording()
  }

  /** Set a single attribute on the span. */
  setAttribute(key: string, value: string | number | boolean): this {
    if (this.ended) return this
    try {
      this.otelSpan.setAttribute(key, value)
    } catch (err) {
      this.logger.warn('Failed to set span attribute', { key, error: err })
    }
    return this
  }

  /** Set multiple attributes at once. */
  setAttributes(attributes: Attributes): this {
    if (this.ended) return this
    try {
      this.otelSpan.setAttributes(attributes)
    } catch (err) {
      this.logger.warn('Failed to set span attributes', { error: err })
    }
    return this
  }

  /** Record an event (annotation) on the span. */
  addEvent(name: string, attributes?: Attributes): this {
    if (this.ended) return this
    try {
      if (attributes) {
        this.otelSpan.addEvent(name, attributes)
      } else {
        this.otelSpan.addEvent(name)
      }
    } catch (err) {
      this.logger.warn('Failed to add span event', { name, error: err })
    }
    return this
  }

  /** Record an error on the span. Sets status to ERROR. */
  recordError(error: Error, attributes?: Attributes): this {
    if (this.ended) return this
    try {
      if (attributes) {
        this.otelSpan.setAttributes(attributes)
      }
      this.otelSpan.recordException(error)
      this.otelSpan.setStatus({
        code: SpanStatusCode.ERROR,
        message: error.message,
      })
    } catch (err) {
      this.logger.warn('Failed to record span error', { error: err })
    }
    return this
  }

  /** Set the span status. */
  setStatus(status: SpanStatus, message?: string): this {
    if (this.ended) return this
    try {
      const code =
        status === 'ok'
          ? SpanStatusCode.OK
          : status === 'error'
            ? SpanStatusCode.ERROR
            : SpanStatusCode.UNSET
      this.otelSpan.setStatus(message ? { code, message } : { code })
    } catch (err) {
      this.logger.warn('Failed to set span status', { error: err })
    }
    return this
  }

  /** End the span. Idempotent — calling multiple times is safe. */
  end(endTime?: TimeInput): void {
    if (this.ended) return
    this.ended = true
    try {
      this.otelSpan.end(endTime)
    } catch (err) {
      this.logger.warn('Failed to end span', { error: err })
    }
  }

  /** Get the underlying OTel span (for advanced use cases). */
  getOTelSpan(): OTelSpan {
    return this.otelSpan
  }
}
