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

import { trace, context as otelContext } from '@opentelemetry/api'
import { getRequestContext } from './context.js'

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SerializedContext {
    readonly traceId: string
    readonly spanId: string
    readonly traceFlags: number
    readonly traceState?: string | undefined
    readonly requestId?: string | undefined
    readonly sessionId?: string | undefined
    readonly tenantId?: string | undefined
}

// ─── Serialize (Main Thread → Worker) ───────────────────────────────────────

/**
 * Serialize the current OTel span context + SDK request context
 * into a plain object for passing to worker threads.
 *
 * Returns null if no active span context exists.
 */
export function serializeContext(): SerializedContext | null {
    const activeSpan = trace.getActiveSpan()
    const spanContext = activeSpan?.spanContext()

    if (!spanContext) {
        return null
    }

    const requestContext = getRequestContext()

    return {
        traceId: spanContext.traceId,
        spanId: spanContext.spanId,
        traceFlags: spanContext.traceFlags,
        traceState: spanContext.traceState?.serialize(),
        requestId: requestContext?.requestId,
        sessionId: requestContext?.sessionId,
        tenantId: (requestContext?.extra as Record<string, unknown> | undefined)?.['tenantId'] as string | undefined,
    }
}

/**
 * Create workerData for worker_threads.Worker constructor.
 * Includes serialized context + any additional data.
 */
export function createWorkerData(additionalData?: Record<string, unknown>): Record<string, unknown> {
    return {
        ...additionalData,
        __pulseContext: serializeContext(),
    }
}

/**
 * Extract serialized context from workerData on the worker side.
 * Call this inside the worker thread to get correlation metadata.
 */
export function extractWorkerContext(workerData: Record<string, unknown>): SerializedContext | null {
    const ctx = workerData['__pulseContext']
    if (!ctx || typeof ctx !== 'object') return null
    return ctx as SerializedContext
}
