/**
 * Error capture — captures exceptions and routes them through the event pipeline.
 * Features canonical signature: captureException(error, severity?).
 */

import { toError } from '../core/errors.js'
import { getLogger } from '../utils/logger.js'
import { parseStack } from '../processors/stack-parser.js'
import { generateFingerprint } from '../processors/fingerprint.js'
import { getRequestContext, getSpanId, getTraceId } from '../core/context.js'
import { captureEvent } from './captureEvent.js'
import { Severity, severityFromString, type SeverityLevel } from '../types/severity.js'
import { epochMs } from '../utils/time.js'
import type { ErrorEvent } from '../types/event.js'
import type { Breadcrumb } from '../types/breadcrumb.js'
import { KillswitchEngine } from '../core/killswitch-engine.js'
import { ERROR_DEFAULTS } from '../constants/internal-defaults.js'
import { SpanStatusCode, trace } from '@opentelemetry/api'
import { SecurityScrubber } from '../processors/security-scrubber.js'
import type { ErrorSeverity } from '../types/error.js'
import { classifyError } from '../core/error-classifier.js'

export type { ErrorSeverity }

/**
 * Capture an error/exception.
 *
 * Error capture is synchronous for minimal latency. Source map resolution
 * is deferred to the event pipeline's async processing stage.
 *
 * Remote config gates:
 *   killswitches.disableErrors → no-op
 *   sampling.errors → probabilistic drop
 *   errors.grouping.normalizePaths → strip absolute paths in fingerprint
 *
 * @param error - The error to capture (Error, string, or unknown)
 * @param severity - Optional severity level ('fatal' | 'error' | 'warning' | 'info' | 'debug') or options object with severity. Defaults to 'error'.
 */
export function captureException(
  error: unknown,
  severity?: ErrorSeverity | { severity?: ErrorSeverity } | SeverityLevel
): void {
  const logger = getLogger()

  try {
    // ─── Killswitch Gate ──────────────────────────────────────────────
    const killswitch = KillswitchEngine.getInstance()
    if (killswitch?.isKilled('disableErrors')) {
      return // Silently no-op when errors are killed
    }

    const normalized = toError(error)
    const activeSpan = trace.getActiveSpan()

    if (activeSpan) {
      try {
        activeSpan.recordException(normalized)
        activeSpan.setStatus({ code: SpanStatusCode.ERROR, message: normalized.message })
      } catch {
        // Error capture must remain best-effort and never alter host control flow.
      }
    }

    let severityInput = severity
    if (typeof severity === 'object' && severity !== null && 'severity' in severity) {
      severityInput = (severity as { severity?: ErrorSeverity }).severity
    }
    const resolvedSeverity: SeverityLevel = severityInput ? severityFromString(severityInput, Severity.Error) : Severity.Error

    let statusCode: number | undefined = undefined
    let statusText: string | undefined = undefined
    let method: string | undefined = undefined
    let route: string | undefined = undefined
    let url: string | undefined = undefined
    let mechanism = 'manual'
    let handled = true

    const ctx = getRequestContext()

    // Automatically enrich HTTP information and mechanism/handled metadata from the active request context store if present.
    if (ctx?.extra) {
      if (typeof ctx.extra.getStatusCode === 'function') {
        try { statusCode = ctx.extra.getStatusCode() } catch {}
      } else if (typeof (ctx.extra as Record<string, unknown>)['statusCode'] === 'number') {
        statusCode = (ctx.extra as Record<string, unknown>)['statusCode'] as number
      }
      if (typeof ctx.extra.getMethod === 'function') {
        try { method = ctx.extra.getMethod() } catch {}
      }
      if (typeof ctx.extra.getRoute === 'function') {
        try { route = ctx.extra.getRoute() } catch {}
      }
      if (typeof ctx.extra.getUrl === 'function') {
        try { url = ctx.extra.getUrl() } catch {}
      }
      if (typeof ctx.extra.mechanism === 'string' && ctx.extra.mechanism) {
        mechanism = ctx.extra.mechanism
      }
      if (typeof ctx.extra.handled === 'boolean') {
        handled = ctx.extra.handled
      }
    }

    if (!statusCode && typeof (normalized as unknown as Record<string, unknown>)['statusCode'] === 'number') {
      statusCode = (normalized as unknown as Record<string, unknown>)['statusCode'] as number
    } else if (!statusCode && typeof (normalized as unknown as Record<string, unknown>)['status'] === 'number') {
      statusCode = (normalized as unknown as Record<string, unknown>)['status'] as number
    }

    // Centralized classification derived deterministically from source facts
    const classification = classifyError(handled, mechanism, resolvedSeverity)

    // Parse stack frames synchronously — uses V8 CallSite API when available,
    // falls back to regex for pre-serialized stacks
    const stackFrames = parseStack(normalized.stack, normalized)

    // ─── Path Normalization for Grouping ──────────────────────────────
    let normalizedFrames = stackFrames
    try {
      if (ERROR_DEFAULTS.grouping.enabled && ERROR_DEFAULTS.grouping.normalizePaths) {
        normalizedFrames = stackFrames.map(frame => {
          if (frame.filename) {
            // Strip absolute paths to relative: /home/user/app/src/index.js → src/index.js
            const normalized = frame.filename.replace(/^.*?[/\\](src|lib|dist|app)[/\\]/, '$1/')
            return { ...frame, filename: normalized }
          }
          return frame
        })
      }
    } catch {
      // Defensive — should never throw
    }

    // Generate fingerprint from normalized frames
    const fingerprint = generateFingerprint(normalized, normalizedFrames)

    // Scrub free-form error message before it leaves the process
    const scrubber = SecurityScrubber.getInstance()
    const safeMessage = scrubber ? (scrubber.scrubValue(normalized.message) as string) : normalized.message

    const rawBreadcrumbs = ctx?.breadcrumbs.toArray() ?? []
    const breadcrumbs = rawBreadcrumbs.length > 0
      ? (scrubber ? rawBreadcrumbs.map(b => scrubBreadcrumb(b, scrubber)) : rawBreadcrumbs)
      : undefined

    const event: ErrorEvent = {
      type: 'error',
      message: safeMessage,
      name: normalized.name,
      stack: stackFrames, // Keep original stack for display
      fingerprint,
      severity: resolvedSeverity,
      timestamp: epochMs(),
      context: {},
      mechanism,
      handled,
      classification,
      breadcrumbs,
      requestId: ctx?.requestId,
      traceId: getTraceId(),
      spanId: getSpanId(),
      ...(statusCode !== undefined ? { statusCode } : {}),
      ...(statusText !== undefined ? { statusText } : {}),
      ...(method !== undefined ? { method } : {}),
      ...(route !== undefined ? { route } : {}),
      ...(url !== undefined ? { url } : {}),
    }

    captureEvent(event)
  } catch (err) {
    logger.error('captureException failed', { error: err })
  }
}

function scrubBreadcrumb(breadcrumb: Breadcrumb, scrubber: SecurityScrubber): Breadcrumb {
  const safeMessage = breadcrumb.message !== undefined
    ? (scrubber.scrubValue(breadcrumb.message) as string)
    : undefined
  const safeData = breadcrumb.data !== undefined
    ? (scrubber.scrubValue(breadcrumb.data) as Record<string, unknown>)
    : undefined
  return {
    ...breadcrumb,
    message: safeMessage,
    data: safeData,
  }
}

