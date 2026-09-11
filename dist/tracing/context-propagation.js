/**
 * W3C Trace Context Propagation — extracts and injects trace context
 * from/into HTTP headers following the W3C specification.
 *
 * Uses native OpenTelemetry propagation APIs (`propagation.extract`,
 * `propagation.inject`) rather than manual traceparent parsing so that
 * OTel samplers, propagators, and context managers remain in control.
 */
import { propagation, trace, context as otelContext, } from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { getLogger } from '../utils/logger.js';
import { ConfigManager } from '../core/config-manager.js';
import { TRACING_DEFAULTS } from '../constants/internal-defaults.js';
// ─── W3C Header Constants ───────────────────────────────────────────────────
const TRACEPARENT_HEADER = 'traceparent';
const TRACESTATE_HEADER = 'tracestate';
const PULSE_TRACE_ID_HEADER = 'x-pulse-trace-id';
const PULSE_SPAN_ID_HEADER = 'x-pulse-span-id';
const PULSE_SAMPLED_HEADER = 'x-pulse-sampled';
const fallbackW3CPropagator = new W3CTraceContextPropagator();
// ─── Text Map Carrier Helpers ───────────────────────────────────────────────
/**
 * Standard getter for extracting headers from an incoming request.
 * Works with plain objects and case-insensitive headers.
 */
export const headerGetter = {
    keys(carrier) {
        if (!carrier || typeof carrier !== 'object')
            return [];
        return Object.keys(carrier);
    },
    get(carrier, key) {
        if (!carrier || typeof carrier !== 'object')
            return undefined;
        if (key in carrier) {
            const value = carrier[key];
            return Array.isArray(value) ? value[0] : value;
        }
        const lowerKey = key.toLowerCase();
        if (lowerKey in carrier) {
            const value = carrier[lowerKey];
            return Array.isArray(value) ? value[0] : value;
        }
        for (const k of Object.keys(carrier)) {
            if (k.toLowerCase() === lowerKey) {
                const value = carrier[k];
                return Array.isArray(value) ? value[0] : value;
            }
        }
        return undefined;
    },
};
/**
 * Standard setter for injecting headers into an outgoing request.
 */
export const headerSetter = {
    set(carrier, key, value) {
        if (!carrier || typeof carrier !== 'object')
            return;
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
    if (!headers || typeof headers !== 'object') {
        return otelContext.active();
    }
    const logger = getLogger();
    try {
        let extracted = propagation.extract(otelContext.active(), headers, headerGetter);
        let spanContext = trace.getSpanContext(extracted);
        if (!spanContext || !trace.isSpanContextValid(spanContext)) {
            const direct = fallbackW3CPropagator.extract(otelContext.active(), headers, headerGetter);
            const directSpanContext = trace.getSpanContext(direct);
            if (directSpanContext && trace.isSpanContextValid(directSpanContext)) {
                extracted = direct;
                spanContext = directSpanContext;
            }
        }
        if (!spanContext || !trace.isSpanContextValid(spanContext)) {
            const pulseTraceId = headerGetter.get(headers, PULSE_TRACE_ID_HEADER);
            const pulseSpanId = headerGetter.get(headers, PULSE_SPAN_ID_HEADER);
            if (typeof pulseTraceId === 'string' &&
                typeof pulseSpanId === 'string' &&
                /^[0-9a-f]{32}$/i.test(pulseTraceId) &&
                /^[0-9a-f]{16}$/i.test(pulseSpanId)) {
                const pulseSampled = headerGetter.get(headers, PULSE_SAMPLED_HEADER);
                const traceFlags = pulseSampled === '1' || pulseSampled === 'true' ? 1 : 0;
                const pulseSpanContext = {
                    traceId: pulseTraceId.toLowerCase(),
                    spanId: pulseSpanId.toLowerCase(),
                    traceFlags,
                    isRemote: true,
                };
                extracted = trace.setSpanContext(extracted, pulseSpanContext);
                spanContext = pulseSpanContext;
            }
        }
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
    if (!headers || typeof headers !== 'object')
        return;
    const logger = getLogger();
    try {
        const activeCtx = ctx ?? otelContext.active();
        // Only inject headers for propagation formats enabled in remote config.
        // Propagation flags moved out of the wire schema in v3 — they are now
        // SDK-internal defaults (`TRACING_DEFAULTS.propagation`). Re-introduce
        // a remote knob if customers ever need per-tenant control.
        const shouldInjectW3C = TRACING_DEFAULTS.propagation.w3c;
        if (shouldInjectW3C) {
            propagation.inject(activeCtx, headers, headerSetter);
            if (!headers[TRACEPARENT_HEADER]) {
                fallbackW3CPropagator.inject(activeCtx, headers, headerSetter);
            }
        }
        // Also inject Pulse custom headers for non-OTel consumers
        const spanContext = trace.getSpanContext(activeCtx);
        if (spanContext && trace.isSpanContextValid(spanContext)) {
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
// ─── Header Constants ───────────────────────────────────────────────────────
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
