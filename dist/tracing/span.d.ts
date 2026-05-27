/**
 * PulseSpan — minimal ergonomic wrapper around OTel Span.
 *
 * Design principles (v3.0):
 *   - ZERO duplicated state. Every getter reads LIVE from the OTel span.
 *   - The OTel ReadableSpan is the single source of truth.
 *   - PulseSpan only adds:
 *     1. Idempotent end() — safe to call multiple times
 *     2. Never-throw safety — all operations wrapped in try/catch
 *     3. Fluent API — setAttribute/addEvent return `this`
 *     4. parentSpanId — captured at construction from active context
 *   - All enrichment (X-Pulse-Tenant, tenant tags, SDK metadata) happens
 *     in PipelineSpanExporter.spanToEvent(), NOT here.
 */
import { type Span as OTelSpan, type SpanContext, type Attributes, type TimeInput, type Link } from '@opentelemetry/api';
export type SpanStatus = 'ok' | 'error' | 'unset';
export interface SpanOptions {
    /** Custom attributes to attach to the span at creation. */
    attributes?: Attributes;
    /** ISO timestamp to use as span start time. */
    startTime?: TimeInput;
    /** Span links — for batch processing, fan-out, or queue consumer patterns. */
    links?: SpanLink[];
    /**
     * Hard timeout for the span in milliseconds.
     *
     * If the operation exceeds this deadline, the span is force-ended with
     * an ERROR status and a `pulse.span.timeout` event. The operation itself
     * continues uninterrupted (fail-open semantics — the SDK never cancels
     * user work).
     *
     * This prevents span leaks from hung operations that never resolve.
     * The timer is `.unref()`'d so it does not keep the event loop alive.
     */
    timeoutMs?: number;
}
/**
 * A link to another span — models non-parent-child causal relationships.
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
 * Thin ergonomic wrapper around OTel Span.
 *
 * - Never throws — all operations are isolated.
 * - No duplicated state — reads everything from the underlying OTel span.
 * - Fluent API for attribute/event chaining.
 */
export declare class PulseSpan implements OTelSpan {
    /** @internal The underlying OTel span — use getOTelSpan() for advanced access. */
    private readonly _span;
    /**
     * Parent span ID captured at construction from the OTel context.
     * Stored here because the OTel Span API doesn't expose parentSpanId
     * on the public interface (only on ReadableSpan after export).
     */
    private readonly _parentSpanId;
    /** Idempotent end guard — prevents double-end. */
    private _ended;
    constructor(otelSpan: OTelSpan);
    /** Span ID — read live from OTel span context. */
    get spanId(): string;
    /** Trace ID — read live from OTel span context. */
    get traceId(): string;
    /** Parent span ID — captured at construction from active context. */
    get parentSpanId(): string | undefined;
    /** Whether this span is still recording (not ended). */
    isRecording(): boolean;
    /** Whether this span has been ended via PulseSpan.end(). */
    get isEnded(): boolean;
    /** Full OTel span context (traceId, spanId, traceFlags, traceState). */
    spanContext(): SpanContext;
    /** Set a single attribute. No-op after end. */
    setAttribute(key: string, value: string | number | boolean): this;
    /** Set multiple attributes at once. No-op after end. */
    setAttributes(attributes: Attributes): this;
    /** Record a span event (annotation). No-op after end. */
    addEvent(name: string, attributes?: Attributes): this;
    /** Add a single link to the span. No-op after end. */
    addLink(link: Link): this;
    /** Add multiple links to the span. No-op after end. */
    addLinks(links: Link[]): this;
    /**
     * Record an error on the span.
     * Sets status to ERROR and records the exception as a span event.
     */
    recordError(error: Error, attributes?: Attributes): this;
    /**
     * OTel compat: recordException.
     */
    recordException(exception: any, time?: TimeInput): this;
    /**
     * OTel compat: updateName.
     */
    updateName(name: string): this;
    /** Set the span status. */
    setStatus(status: import('@opentelemetry/api').SpanStatus): this;
    setStatus(status: SpanStatus, message?: string): this;
    /** End the span. Idempotent — calling multiple times is safe. */
    end(endTime?: TimeInput): void;
    /**
     * Get the underlying OTel Span for advanced use cases.
     * Prefer the PulseSpan API — only use this for OTel interop.
     */
    getOTelSpan(): OTelSpan;
    /**
     * Convert SpanLink[] to OTel Link[] format for use at span creation time.
     * @internal
     */
    static toOTelLinks(links: SpanLink[]): Link[];
}
//# sourceMappingURL=span.d.ts.map