/**
 * Request capture — captures HTTP request/response events.
 *
 * Delegates to the central event pipeline for normalization, sanitization,
 * sampling, and plugin processing.
 */
import { captureEvent } from './captureEvent.js';
import { getLogger } from '../utils/logger.js';
import { trace } from '@opentelemetry/api';
import { getRequestContext, getSpanId, getTraceId } from '../core/context.js';
/**
 * Capture an HTTP request event.
 * Automatically enriches with OTel trace context (traceId, spanId) and request context
 * to maintain correlation identity.
 *
 * Sampling is handled by the event pipeline — callers don't need to filter.
 */
export function captureRequest(event) {
    const logger = getLogger();
    try {
        const activeSpan = trace.getActiveSpan();
        const ctx = getRequestContext();
        const traceId = event.traceId ?? activeSpan?.spanContext().traceId ?? ctx?.traceId ?? getTraceId();
        const spanId = event.spanId ?? activeSpan?.spanContext().spanId ?? ctx?.spanId ?? getSpanId();
        const requestId = event.requestId || ctx?.requestId;
        const enriched = {
            ...event,
            type: 'request',
            ...(traceId ? { traceId } : {}),
            ...(spanId ? { spanId } : {}),
            ...(requestId ? { requestId } : {}),
        };
        captureEvent(enriched);
    }
    catch (err) {
        logger.error('captureRequest failed', {
            error: err,
            requestId: event.requestId,
            endpoint: event.url,
        });
    }
}
