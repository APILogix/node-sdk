/**
 * LynkTraceSpan — minimal ergonomic wrapper around OTel Span.
 *
 * Design principles (v3.0):
 *   - ZERO duplicated state. Every getter reads LIVE from the OTel span.
 *   - The OTel ReadableSpan is the single source of truth.
 *   - LynkTraceSpan only adds:
 *     1. Idempotent end() — safe to call multiple times
 *     2. Never-throw safety — all operations wrapped in try/catch
 *     3. Fluent API — setAttribute/addEvent return `this`
 *     4. parentSpanId — captured at construction from a *parent context*
 *        the caller resolves *before* entering startActiveSpan.
 *   - All enrichment (X-Pulse-Tenant, tenant tags, SDK metadata) happens
 *     in PipelineSpanExporter.spanToEvent(), NOT here.
 *
 * Why parentSpanId is captured by the caller, not inside the constructor:
 *   `tracer.startActiveSpan(name, opts, cb)` installs the new span as the
 *   active span *before* the callback runs. If we read `trace.getActiveSpan()`
 *   inside the constructor (which is called inside that callback), we'd read
 *   the new span itself, so the "parent != self" guard would always fail and
 *   `parentSpanId` would be undefined for every span the user creates via
 *   `withSpan` / `withSpanSync`. To get the real parent, the caller must
 *   snapshot the active span *before* opening the new active scope and pass
 *   it as `parentSpanId` here. The exporter is unaffected because it reads
 *   `parentSpanContext` from the OTel `ReadableSpan` directly.
 */

import {
    type Span as OTelSpan,
    type Context,
    type SpanContext,
    SpanStatusCode,
    type Attributes,
    type TimeInput,
    type Link,
} from '@opentelemetry/api'
import { getLogger } from '../utils/logger.js'
// ─── Types ──────────────────────────────────────────────────────────────────

export type SpanStatus = 'ok' | 'error' | 'unset'
export type SpanKindName = 'internal' | 'server' | 'client' | 'producer' | 'consumer'

export interface SpanOptions {
    /** Custom attributes to attach to the span at creation. */
    attributes?: Attributes
    /** OpenTelemetry span kind. Use `client` for outbound DB/cache/HTTP dependency spans. */
    kind?: SpanKindName
    /**
     * Explicit parent for cases where the active async context is unavailable
     * (custom queues, worker bridges, or manual context handoff).
     */
    parent?: LynkTraceSpan | OTelSpan | SpanContext | Context
    /** ISO timestamp to use as span start time. */
    startTime?: TimeInput
    /** Span links — for batch processing, fan-out, or queue consumer patterns. */
    links?: SpanLink[]
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
    timeoutMs?: number
}

/**
 * A link to another span — models non-parent-child causal relationships.
 */
export interface SpanLink {
    /** Trace ID of the linked span. */
    traceId: string
    /** Span ID of the linked span. */
    spanId: string
    /** Optional attributes describing the link relationship. */
    attributes?: Attributes
}

// ─── LynkTraceSpan ──────────────────────────────────────────────────────────

/**
 * Thin ergonomic wrapper around OTel Span.
 *
 * - Never throws — all operations are isolated.
 * - No duplicated state — reads everything from the underlying OTel span.
 * - Fluent API for attribute/event chaining.
 */
export class LynkTraceSpan implements OTelSpan {
    /** @internal The underlying OTel span — use getOTelSpan() for advanced access. */
    private readonly _span: OTelSpan

    /**
     * Parent span ID, supplied by the caller at construction time.
     *
     * The caller (typically `withSpan` / `withSpanSync` / `startSpan` in
     * `tracer.ts`) snapshots `trace.getActiveSpan()?.spanContext().spanId`
     * *before* opening a new active scope and passes it here. Reading the
     * active span from inside the constructor would return the new span
     * itself (because `tracer.startActiveSpan` installs it as active before
     * invoking the callback), so we cannot do that lookup here.
     *
     * The exporter does NOT depend on this value — `PipelineSpanExporter`
     * reads `parentSpanContext` from the OTel `ReadableSpan`. This field is
     * for the user-facing `pulseSpan.parentSpanId` getter only.
     */
    private readonly _parentSpanId: string | undefined

    /** Idempotent end guard — prevents double-end. */
    private _ended = false

    constructor(otelSpan: OTelSpan, parentSpanId?: string) {
        this._span = otelSpan
        this._parentSpanId = parentSpanId
    }

    // ─── Read-Through Getters (no duplicated state) ─────────────────────

    /** Span ID — read live from OTel span context. */
    get spanId(): string {
        return this._span.spanContext().spanId
    }

    /** Trace ID — read live from OTel span context. */
    get traceId(): string {
        return this._span.spanContext().traceId
    }

    /** Parent span ID — captured at construction from active context. */
    get parentSpanId(): string | undefined {
        return this._parentSpanId
    }

    /**
     * Get the current span attributes (read-only snapshot).
     */
    get attributes(): Attributes {
        return (this._span as any).attributes ?? {}
    }

    /** Whether this span is still recording (not ended). */
    isRecording(): boolean {
        return this._span.isRecording()
    }

    /** Whether this span has been ended via PulseSpan.end(). */
    get isEnded(): boolean {
        return this._ended
    }

    /** Full OTel span context (traceId, spanId, traceFlags, traceState). */
    spanContext(): SpanContext {
        return this._span.spanContext()
    }

    // ─── Mutation Methods (all never-throw, fluent) ─────────────────────

    /** Set a single attribute. No-op after end. */
    setAttribute(key: string, value: string | number | boolean): this {
        if (this._ended) return this
        try {
            this._span.setAttribute(key, value)
        } catch (err) {
            getLogger().warn('Failed to set span attribute', { key, error: err })
        }
        return this
    }

    /** Set multiple attributes at once. No-op after end. */
    setAttributes(attributes: Attributes): this {
        if (this._ended) return this
        try {
            this._span.setAttributes(attributes)
        } catch (err) {
            getLogger().warn('Failed to set span attributes', { error: err })
        }
        return this
    }

    /** Record a span event (annotation). No-op after end. */
    addEvent(name: string, attributes?: Attributes): this {
        if (this._ended) return this
        try {
            if (attributes) {
                this._span.addEvent(name, attributes)
            } else {
                this._span.addEvent(name)
            }
        } catch (err) {
            getLogger().warn('Failed to add span event', { name, error: err })
        }
        return this
    }

    /** Add a single link to the span. No-op after end. */
    addLink(link: Link): this {
        if (this._ended) return this
        try {
            this._span.addLink(link)
        } catch (err) {
            getLogger().warn('Failed to add span link', { error: err })
        }
        return this
    }

    /** Add multiple links to the span. No-op after end. */
    addLinks(links: Link[]): this {
        if (this._ended) return this
        try {
            this._span.addLinks(links)
        } catch (err) {
            getLogger().warn('Failed to add span links', { error: err })
        }
        return this
    }

    /**
     * Record an error on the span.
     * Sets status to ERROR and records the exception as a span event.
     */
    recordError(error: Error, attributes?: Attributes): this {
        if (this._ended) return this
        try {
            if (attributes) {
                this._span.setAttributes(attributes)
            }
            this._span.recordException(error)
            this._span.setStatus({
                code: SpanStatusCode.ERROR,
                message: error.message,
            })
        } catch (err) {
            getLogger().warn('Failed to record span error', { error: err })
        }
        return this
    }

    /**
     * OTel compat: recordException.
     */
    recordException(exception: any, time?: TimeInput): this {
        if (this._ended) return this
        try {
            this._span.recordException(exception, time)
        } catch (err) {
            getLogger().warn('Failed to record exception', { error: err })
        }
        return this
    }

    /**
     * OTel compat: updateName.
     */
    updateName(name: string): this {
        if (this._ended) return this
        try {
            this._span.updateName(name)
        } catch (err) {
            getLogger().warn('Failed to update span name', { error: err })
        }
        return this
    }

    /** Set the span status. */
    setStatus(status: import('@opentelemetry/api').SpanStatus): this;
    setStatus(status: SpanStatus, message?: string): this;
    setStatus(status: SpanStatus | import('@opentelemetry/api').SpanStatus, message?: string): this {
        if (this._ended) return this
        try {
            if (typeof status === 'object') {
                this._span.setStatus(status)
            } else {
                const code =
                    status === 'ok'
                        ? SpanStatusCode.OK
                        : status === 'error'
                            ? SpanStatusCode.ERROR
                            : SpanStatusCode.UNSET
                this._span.setStatus(message ? { code, message } : { code })
            }
        } catch (err) {
            getLogger().warn('Failed to set span status', { error: err })
        }
        return this
    }

    /** End the span. Idempotent — calling multiple times is safe. */
    end(endTime?: TimeInput): void {
        if (this._ended) return
        this._ended = true
        
        try {
            this._span.end(endTime)
        } catch (err) {
            getLogger().warn('Failed to end span', { error: err })
        }
    }

    /**
     * Get the underlying OTel Span for advanced use cases.
     * Prefer the PulseSpan API — only use this for OTel interop.
     */
    getOTelSpan(): OTelSpan {
        return this._span
    }

    // ─── Static Utilities ───────────────────────────────────────────────

    /**
     * Convert SpanLink[] to OTel Link[] format for use at span creation time.
     * @internal
     */
    static toOTelLinks(links: SpanLink[]): Link[] {
        return links.map(link => {
            const otelLink: Link = {
                context: {
                    traceId: link.traceId,
                    spanId: link.spanId,
                    traceFlags: 1, // sampled
                } as SpanContext,
            }
            if (link.attributes) {
                otelLink.attributes = link.attributes
            }
            return otelLink
        })
    }
}
