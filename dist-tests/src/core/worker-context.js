/**
 * Worker Context Serialization — context propagation for worker threads.
 *
 * OTel context/lifecycle MUST remain on the main thread.
 * Worker threads receive serialized context for correlation only —
 * they do NOT create/manage OTel providers or exporters.
 *
 * This module:
 * - Serializes OTel span context + SDK request context → transferable data
 * - Deserializes on worker side for correlation metadata
 * - Provides worker data helpers for worker_threads postMessage
 */
import { trace, context as otelContext } from '@opentelemetry/api';
import { getRequestContext } from './context.js';
// ─── Serialize (Main Thread → Worker) ───────────────────────────────────────
/**
 * Serialize the current OTel span context + SDK request context
 * into a plain object for passing to worker threads.
 *
 * Returns null if no active span context exists.
 */
export function serializeContext() {
    const activeSpan = trace.getActiveSpan();
    const spanContext = activeSpan?.spanContext();
    if (!spanContext) {
        return null;
    }
    const requestContext = getRequestContext();
    return {
        traceId: spanContext.traceId,
        spanId: spanContext.spanId,
        traceFlags: spanContext.traceFlags,
        traceState: spanContext.traceState?.serialize(),
        requestId: requestContext?.requestId,
        sessionId: requestContext?.sessionId,
        tenantId: requestContext?.extra?.['tenantId'],
    };
}
/**
 * Create workerData for worker_threads.Worker constructor.
 * Includes serialized context + any additional data.
 */
export function createWorkerData(additionalData) {
    const serialized = serializeContext();
    return {
        ...additionalData,
        __lynktraceContext: serialized,
        __pulseContext: serialized,
    };
}
/**
 * Extract serialized context from workerData on the worker side.
 * Call this inside the worker thread to get correlation metadata.
 */
export function extractWorkerContext(workerData) {
    const ctx = workerData['__lynktraceContext'] ?? workerData['__pulseContext'];
    if (!ctx || typeof ctx !== 'object')
        return null;
    return ctx;
}
