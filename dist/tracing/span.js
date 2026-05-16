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
import { SpanStatusCode, } from '@opentelemetry/api';
import { getLogger } from '../utils/logger.js';
/**
 * PulseSpan wraps an OTel Span with ergonomic helpers.
 * Never throws — all operations are isolated.
 */
export class PulseSpan {
    otelSpan;
    ended = false;
    constructor(otelSpan) {
        this.otelSpan = otelSpan;
    }
    /** Get the span ID. */
    get spanId() {
        return this.otelSpan.spanContext().spanId;
    }
    /** Get the trace ID. */
    get traceId() {
        return this.otelSpan.spanContext().traceId;
    }
    /** Whether this span is still recording. */
    get isRecording() {
        return this.otelSpan.isRecording();
    }
    /** Set a single attribute on the span. */
    setAttribute(key, value) {
        if (this.ended)
            return this;
        try {
            this.otelSpan.setAttribute(key, value);
        }
        catch (err) {
            getLogger().warn('Failed to set span attribute', { key, error: err });
        }
        return this;
    }
    /** Set multiple attributes at once. */
    setAttributes(attributes) {
        if (this.ended)
            return this;
        try {
            this.otelSpan.setAttributes(attributes);
        }
        catch (err) {
            getLogger().warn('Failed to set span attributes', { error: err });
        }
        return this;
    }
    /** Record an event (annotation) on the span. */
    addEvent(name, attributes) {
        if (this.ended)
            return this;
        try {
            if (attributes) {
                this.otelSpan.addEvent(name, attributes);
            }
            else {
                this.otelSpan.addEvent(name);
            }
        }
        catch (err) {
            getLogger().warn('Failed to add span event', { name, error: err });
        }
        return this;
    }
    /** Record an error on the span. Sets status to ERROR. */
    recordError(error, attributes) {
        if (this.ended)
            return this;
        try {
            if (attributes) {
                this.otelSpan.setAttributes(attributes);
            }
            this.otelSpan.recordException(error);
            this.otelSpan.setStatus({
                code: SpanStatusCode.ERROR,
                message: error.message,
            });
        }
        catch (err) {
            getLogger().warn('Failed to record span error', { error: err });
        }
        return this;
    }
    /** Set the span status. */
    setStatus(status, message) {
        if (this.ended)
            return this;
        try {
            const code = status === 'ok'
                ? SpanStatusCode.OK
                : status === 'error'
                    ? SpanStatusCode.ERROR
                    : SpanStatusCode.UNSET;
            this.otelSpan.setStatus(message ? { code, message } : { code });
        }
        catch (err) {
            getLogger().warn('Failed to set span status', { error: err });
        }
        return this;
    }
    /** End the span. Idempotent — calling multiple times is safe. */
    end(endTime) {
        if (this.ended)
            return;
        this.ended = true;
        try {
            this.otelSpan.end(endTime);
        }
        catch (err) {
            getLogger().warn('Failed to end span', { error: err });
        }
    }
    /** Get the underlying OTel span (for advanced use cases). */
    getOTelSpan() {
        return this.otelSpan;
    }
}
//# sourceMappingURL=span.js.map