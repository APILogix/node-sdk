/**
 * Request capture — captures HTTP request/response events.
 *
 * Delegates to the central event pipeline for normalization, sanitization,
 * sampling, and plugin processing.
 */

import type { RequestEvent } from '../types/event.js'
import { captureEvent } from './captureEvent.js'
import { getLogger } from '../utils/logger.js'
import { trace } from '@opentelemetry/api'

/**
 * Capture an HTTP request event.
 * Automatically enriches with OTel trace context (traceId, spanId) from
 * the active span if not already provided by the caller.
 *
 * Sampling is handled by the event pipeline — callers don't need to filter.
 */
export function captureRequest(event: RequestEvent): void {
  const logger = getLogger()

  try {
    // Enrich with OTel trace context if not already provided
    const activeSpan = trace.getActiveSpan()
    if (activeSpan) {
      const spanContext = activeSpan.spanContext()
      const enriched: RequestEvent = {
        ...event,
        traceId: event.traceId ?? spanContext.traceId,
        spanId: event.spanId ?? spanContext.spanId,
      }
      captureEvent(enriched)
    } else {
      captureEvent(event)
    }
  } catch (err) {
    logger.error('captureRequest failed', {
      error: err,
      requestId: event.requestId,
      endpoint: event.url,
    })
  }
}
