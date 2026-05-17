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
import { type Span as OTelSpan, type Attributes, type TimeInput, type Link } from '@opentelemetry/api';
export type SpanStatus = 'ok' | 'error' | 'unset';
export interface SpanOptions {
    /** Custom attributes to attach to the span at creation. */
    attributes?: Attributes;
    /** Link this span to a parent span ID (manual linking). */
    parentSpanId?: string;
    /** ISO timestamp to use as span start time. */
    startTime?: TimeInput;
    /** Span links — for modeling batch processing, fan-out, or queue consumer patterns. */
    links?: SpanLink[];
}
/**
 * A link to another span — used to model causal relationships that aren't
 * parent-child (e.g., batch consumer linking to multiple producer spans).
 */
export interface SpanLink {
    /** Trace ID of the linked span. */
    traceId: string;
    /** Span ID of the linked span. */
    spanId: string;
    /** Optional attributes describing the link relationship. */
    attributes?: Attributes;
}
/**
 * PulseSpan wraps an OTel Span with ergonomic helpers.
 * Never throws — all operations are isolated.
 */
export declare class PulseSpan {
    private readonly otelSpan;
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
    /**
     * Add a link to another span — models non-parent-child causal relationships.
     *
     * Use cases:
     * - Batch consumer linking to multiple producer spans
     * - Fan-out patterns where one request triggers multiple downstream traces
     * - Queue consumer linking to the producer trace
     *
     * @param link - The span link with traceId, spanId, and optional attributes
     */
    addLink(link: SpanLink): this;
    /** Get the underlying OTel span (for advanced use cases). */
    getOTelSpan(): OTelSpan;
    /**
     * Convert SpanLink[] to OTel Link[] format for use at span creation time.
     * @internal
     */
    static toOTelLinks(links: SpanLink[]): Link[];
}
//# sourceMappingURL=span.d.ts.map