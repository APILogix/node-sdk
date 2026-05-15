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
import { type Span as OTelSpan, type Attributes, type TimeInput } from '@opentelemetry/api';
export type SpanStatus = 'ok' | 'error' | 'unset';
export interface SpanOptions {
    /** Custom attributes to attach to the span at creation. */
    attributes?: Attributes;
    /** Link this span to a parent span ID (manual linking). */
    parentSpanId?: string;
    /** ISO timestamp to use as span start time. */
    startTime?: TimeInput;
}
/**
 * PulseSpan wraps an OTel Span with ergonomic helpers.
 * Never throws — all operations are isolated.
 */
export declare class PulseSpan {
    private readonly otelSpan;
    private readonly logger;
    private ended;
    constructor(otelSpan: OTelSpan);
    /** Get the span ID. */
    get spanId(): string;
    /** Get the trace ID. */
    get traceId(): string;
    /** Whether this span is still recording. */
    get isRecording(): boolean;
    /** Set a single attribute on the span. */
    setAttribute(key: string, value: string | number | boolean): this;
    /** Set multiple attributes at once. */
    setAttributes(attributes: Attributes): this;
    /** Record an event (annotation) on the span. */
    addEvent(name: string, attributes?: Attributes): this;
    /** Record an error on the span. Sets status to ERROR. */
    recordError(error: Error, attributes?: Attributes): this;
    /** Set the span status. */
    setStatus(status: SpanStatus, message?: string): this;
    /** End the span. Idempotent — calling multiple times is safe. */
    end(endTime?: TimeInput): void;
    /** Get the underlying OTel span (for advanced use cases). */
    getOTelSpan(): OTelSpan;
}
//# sourceMappingURL=span.d.ts.map