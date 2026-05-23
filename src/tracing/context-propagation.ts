/**
 * W3C Trace Context Propagation — extracts and injects trace context
 * from/into HTTP headers following the W3C specification.
 *
 * Uses native OpenTelemetry propagation APIs (`propagation.extract`,
 * `propagation.inject`) rather than manual traceparent parsing so that
 * OTel samplers, propagators, and context managers remain in control.
 */

import {
  type Context,
  type TextMapGetter,
  type TextMapSetter,
  propagation,
  trace,
  context as otelContext,
} from '@opentelemetry/api'
import { getLogger } from '../utils/logger.js'
import { ConfigManager } from '../core/config-manager.js'

// ─── W3C Header Constants ───────────────────────────────────────────────────

const TRACEPARENT_HEADER = 'traceparent'
const TRACESTATE_HEADER = 'tracestate'
const PULSE_TRACE_ID_HEADER = 'x-pulse-trace-id'
const PULSE_SPAN_ID_HEADER = 'x-pulse-span-id'
const PULSE_SAMPLED_HEADER = 'x-pulse-sampled'

// ─── Text Map Carrier Helpers ───────────────────────────────────────────────

/**
 * Standard getter for extracting headers from an incoming request.
 * Works with plain objects and case-insensitive headers.
 */
export const headerGetter: TextMapGetter<Record<string, string | string[] | undefined>> = {
  keys(carrier): string[] {
    return Object.keys(carrier)
  },
  get(carrier, key): string | undefined {
    const value = carrier[key] ?? carrier[key.toLowerCase()]
    if (Array.isArray(value)) return value[0]
    return value
  },
}

/**
 * Standard setter for injecting headers into an outgoing request.
 */
export const headerSetter: TextMapSetter<Record<string, string>> = {
  set(carrier, key, value): void {
    carrier[key] = value
  },
}

// ─── Extract ────────────────────────────────────────────────────────────────

/**
 * Extract trace context from incoming HTTP headers.
 * Returns an OTel Context with the extracted span context.
 *
 * @param headers - Incoming request headers (case-insensitive)
 * @returns OTel Context with propagated trace info
 */
export function extractTraceContext(
  headers: Record<string, string | string[] | undefined>
): Context {
  const logger = getLogger()

  try {
    const extracted = propagation.extract(otelContext.active(), headers, headerGetter)

    const spanContext = trace.getSpanContext(extracted)
    if (spanContext) {
      logger.debug('Trace context extracted from headers', {
        traceId: spanContext.traceId,
        spanId: spanContext.spanId,
        sampled: (spanContext.traceFlags & 1) === 1,
      })
    }

    return extracted
  } catch (err) {
    logger.warn('Failed to extract trace context from headers', { error: err })
    return otelContext.active()
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
export function injectTraceContext(
  headers: Record<string, string>,
  ctx?: Context
): void {
  const logger = getLogger()

  try {
    const activeCtx = ctx ?? otelContext.active()

    // Only inject headers for propagation formats enabled in remote config
    let shouldInjectW3C = true
    try {
      const propagationConfig = ConfigManager.getInstance().getConfig().tracing.propagation
      shouldInjectW3C = propagationConfig.w3c !== false
    } catch {
      // ConfigManager not initialized — default to W3C
    }

    if (shouldInjectW3C) {
      propagation.inject(activeCtx, headers, headerSetter)
    }

    // Also inject Pulse custom headers for non-OTel consumers
    const spanContext = trace.getSpanContext(activeCtx)
    if (spanContext) {
      headers[PULSE_TRACE_ID_HEADER] = spanContext.traceId
      headers[PULSE_SPAN_ID_HEADER] = spanContext.spanId
      headers[PULSE_SAMPLED_HEADER] = (spanContext.traceFlags & 1) === 1 ? '1' : '0'

      logger.debug('Trace context injected into headers', {
        traceId: spanContext.traceId,
        spanId: spanContext.spanId,
      })
    }
  } catch (err) {
    logger.warn('Failed to inject trace context into headers', { error: err })
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
} as const
