/**
 * W3C Trace Context Propagation — extracts and injects trace context
 * from/into HTTP headers following the W3C specification.
 *
 * Supports:
 * - traceparent header (W3C Trace Context)
 * - tracestate header (vendor-specific baggage)
 * - Custom Pulse SDK headers (X-Pulse-Trace-Id, X-Pulse-Span-Id)
 *
 * This enables distributed tracing across service boundaries.
 */
import { propagation, trace, context as otelContext, } from '@opentelemetry/api';
import { getLogger } from '../utils/logger.js';
// ─── W3C Header Constants ───────────────────────────────────────────────────
const TRACEPARENT_HEADER = 'traceparent';
const TRACESTATE_HEADER = 'tracestate';
const PULSE_TRACE_ID_HEADER = 'x-pulse-trace-id';
const PULSE_SPAN_ID_HEADER = 'x-pulse-span-id';
const PULSE_SAMPLED_HEADER = 'x-pulse-sampled';
// ─── Text Map Carrier Helpers ───────────────────────────────────────────────
/**
 * Standard getter for extracting headers from an incoming request.
 * Works with plain objects and case-insensitive headers.
 */
export const headerGetter = {
    keys(carrier) {
        return Object.keys(carrier);
    },
    get(carrier, key) {
        const value = carrier[key] ?? carrier[key.toLowerCase()];
        if (Array.isArray(value))
            return value[0];
        return value;
    },
};
/**
 * Standard setter for injecting headers into an outgoing request.
 */
export const headerSetter = {
    set(carrier, key, value) {
        carrier[key] = value;
    },
};
// ─── Extract ────────────────────────────────────────────────────────────────
/**
 * Extract trace context from incoming HTTP headers.
 * Returns an OTel Context with the extracted span context.
 *
 * @param headers - Incoming request headers (case-insensitive)
 * @returns OTel Context with propagated trace info
 */
export function extractTraceContext(headers) {
    const logger = getLogger();
    try {
        const extracted = propagation.extract(otelContext.active(), headers, headerGetter);
        const spanContext = trace.getSpanContext(extracted);
        if (spanContext) {
            logger.debug('Trace context extracted from headers', {
                traceId: spanContext.traceId,
                spanId: spanContext.spanId,
                sampled: (spanContext.traceFlags & 1) === 1,
            });
        }
        return extracted;
    }
    catch (err) {
        logger.warn('Failed to extract trace context from headers', { error: err });
        return otelContext.active();
    }
}
// ─── Inject ─────────────────────────────────────────────────────────────────
/**
 * Inject trace context into outgoing HTTP headers.
 * Adds W3C traceparent/tracestate and Pulse custom headers.
 *
 * @param headers - Mutable headers object to inject into
 * @param ctx - Optional OTel context (defaults to active context)
 */
export function injectTraceContext(headers, ctx) {
    const logger = getLogger();
    try {
        const activeCtx = ctx ?? otelContext.active();
        propagation.inject(activeCtx, headers, headerSetter);
        // Also inject Pulse custom headers for non-OTel consumers
        const spanContext = trace.getSpanContext(activeCtx);
        if (spanContext) {
            headers[PULSE_TRACE_ID_HEADER] = spanContext.traceId;
            headers[PULSE_SPAN_ID_HEADER] = spanContext.spanId;
            headers[PULSE_SAMPLED_HEADER] = (spanContext.traceFlags & 1) === 1 ? '1' : '0';
            logger.debug('Trace context injected into headers', {
                traceId: spanContext.traceId,
                spanId: spanContext.spanId,
            });
        }
    }
    catch (err) {
        logger.warn('Failed to inject trace context into headers', { error: err });
    }
}
// ─── Utilities ──────────────────────────────────────────────────────────────
/**
 * Parse a traceparent header string into its components.
 *
 * Format: {version}-{trace-id}-{parent-id}-{trace-flags}
 * Example: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
 */
export function parseTraceparent(traceparent) {
    const logger = getLogger();
    try {
        const parts = traceparent.trim().split('-');
        if (parts.length !== 4)
            return null;
        const [version, traceId, parentId, flagsHex] = parts;
        if (!version || !traceId || !parentId || !flagsHex)
            return null;
        if (traceId.length !== 32 || parentId.length !== 16)
            return null;
        const traceFlags = parseInt(flagsHex, 16);
        if (Number.isNaN(traceFlags))
            return null;
        return { version, traceId, parentId, traceFlags };
    }
    catch (err) {
        logger.warn('Failed to parse traceparent header', { traceparent, error: err });
        return null;
    }
}
/**
 * Create a W3C traceparent header value.
 */
export function createTraceparent(traceId, spanId, sampled = true) {
    const flags = sampled ? '01' : '00';
    return `00-${traceId}-${spanId}-${flags}`;
}
/**
 * Export header constants for use by instrumentation modules.
 */
export const TRACE_HEADERS = {
    TRACEPARENT: TRACEPARENT_HEADER,
    TRACESTATE: TRACESTATE_HEADER,
    PULSE_TRACE_ID: PULSE_TRACE_ID_HEADER,
    PULSE_SPAN_ID: PULSE_SPAN_ID_HEADER,
    PULSE_SAMPLED: PULSE_SAMPLED_HEADER,
};
//# sourceMappingURL=context-propagation.js.map