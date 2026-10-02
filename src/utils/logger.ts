/**
 * SDK Logger — Sentry-style debug logging.
 *
 * Output strategy (post v3 fix for the console-interception feedback loop):
 *   The SDK never writes through `console.log/info/warn/error`. Those
 *   slots are intercepted by `LoggingSubsystem.installInterceptors()` to
 *   capture user logs as `log` events; if the SDK itself wrote there,
 *   every internal `logger.debug/info/warn/error` call would create a
 *   `log` event, which inside the pipeline produces more debug output,
 *   producing more `log` events — a runaway storm we observed at
 *   thousands of events per second under `setDebugMode(true)`.
 *
 *   Both loggers below now write directly to `process.stdout` (info /
 *   debug) or `process.stderr` (warn / error). The LoggingSubsystem's
 *   wrapper never sees these writes, so the feedback loop is broken at
 *   the source.
 *
 *   PII redaction is always applied regardless of debug mode.
 */

import { SDKError } from '../core/errors.js'
import { Severity, type SeverityLevel, severityMeetsThreshold } from '../types/severity.js'
import { trace as otelTrace } from '@opentelemetry/api'

export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void
  info(message: string, context?: Record<string, unknown>): void
  warn(message: string, context?: Record<string, unknown>): void
  error(message: string, context?: Record<string, unknown>): void
}

// ─── Configuration ──────────────────────────────────────────────────────────

let debugMode = false
let logPrefix = 'Pulse'
let minimumLogLevel: SeverityLevel = Severity.Info

/**
 * Enable or disable debug logging globally.
 * Called during SDK initialization based on `options.debug`.
 */
export function setDebugMode(enabled: boolean): void {
  debugMode = enabled
  minimumLogLevel = enabled ? Severity.Debug : Severity.Info
}

/**
 * Set the minimum SDK internal log level.
 */
export function setLogLevel(level: SeverityLevel): void {
  minimumLogLevel = level
}

/**
 * Set the log prefix (defaults to 'Pulse').
 */
export function setLogPrefix(prefix: string): void {
  logPrefix = prefix
}

// ─── Redaction ──────────────────────────────────────────────────────────────

const SENSITIVE_KEY_PATTERN = /api[-_]?key|api[-_]?secret|authorization|cookie|token|password|secret|credential/i

export function redact(value: unknown, depth = 0): unknown {
  // Prevent infinite recursion on deeply nested objects
  if (depth > 10) return '[max depth]'

  if (typeof value === 'string') {
    return redactString(value)
  }

  if (Array.isArray(value)) {
    return value.map(item => redact(item, depth + 1))
  }

  if (!value || typeof value !== 'object') {
    return value
  }

  if (value instanceof Error) {
    if (value instanceof SDKError) {
      return {
        name: value.name,
        message: value.message,
        code: value.code,
        context: redact(value.context, depth + 1),
        stack: value.stack,
      }
    }

    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    }
  }

  const redacted: Record<string, unknown> = {}
  for (const [key, nestedValue] of Object.entries(value)) {
    redacted[key] = SENSITIVE_KEY_PATTERN.test(key)
      ? '[REDACTED]'
      : redact(nestedValue, depth + 1)
  }

  return redacted
}

function redactString(value: string): string {
  return value
    .replace(/authorization=Bearer\s+([^&\s]+)/gi, 'authorization=Bearer [REDACTED]')
    .replace(/(api[-_]?key|token|authorization|password|secret)=([^&\s]+)/gi, '$1=[REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer [REDACTED]')
}

// ─── Formatting ─────────────────────────────────────────────────────────────

/**
 * Maximum size for a single serialized log context. Larger payloads are
 * truncated to prevent memory spikes from accidentally-large objects
 * (e.g., a user logging a giant request body or response object).
 */
const MAX_LOG_CONTEXT_BYTES = 16 * 1024 // 16 KB

function formatContext(context?: Record<string, unknown>): string {
  if (!context || Object.keys(context).length === 0) return ''

  try {
    const safe = redact(context) as Record<string, unknown>
    const serialized = JSON.stringify(safe)
    if (serialized.length > MAX_LOG_CONTEXT_BYTES) {
      const truncated = serialized.slice(0, MAX_LOG_CONTEXT_BYTES)
      return ` ${truncated}...[truncated:${serialized.length}b]`
    }
    return ' ' + serialized
  } catch {
    return ' [unserializable context]'
  }
}

// ─── Direct stream writers ─────────────────────────────────────────────────
//
// We intentionally do NOT use console.log / console.error here. The
// LoggingSubsystem patches those slots to capture user telemetry, and any
// SDK-originated write would be re-captured as a `log` event, which would
// itself trigger more debug logs, ad infinitum.
//
// `process.stdout.write` / `process.stderr.write` are unaffected by the
// console interception because the wrapper only replaces `console.*`
// methods, not the underlying streams.

function writeStdout(line: string): void {
  // Best-effort. If stdout is detached (e.g., daemonised process), swallow
  // silently rather than throwing — the SDK should never crash the host
  // because we couldn't print a log.
  try {
    process.stdout.write(line + '\n')
  } catch {
    /* stdout closed — nothing we can do */
  }
}

function writeStderr(line: string): void {
  try {
    process.stderr.write(line + '\n')
  } catch {
    /* stderr closed — nothing we can do */
  }
}

function stripPrefix(message: string): string {
  if (message.startsWith(`[${logPrefix}]`)) {
    return message.slice(logPrefix.length + 2).trim()
  }
  return message
}

// ─── Console Logger (Sentry-style) ─────────────────────────────────────────

export const consoleLogger: Logger = {
  debug(message: string, context?: Record<string, unknown>): void {
    if (!severityMeetsThreshold(Severity.Debug, minimumLogLevel)) return
    writeStdout(`[${logPrefix}] DEBUG: ${stripPrefix(message)}${formatContext(context)}`)
  },

  info(message: string, context?: Record<string, unknown>): void {
    if (!severityMeetsThreshold(Severity.Info, minimumLogLevel)) return
    writeStdout(`[${logPrefix}] INFO: ${stripPrefix(message)}${formatContext(context)}`)
  },

  warn(message: string, context?: Record<string, unknown>): void {
    if (!severityMeetsThreshold(Severity.Warning, minimumLogLevel)) return
    writeStderr(`[${logPrefix}] WARN: ${stripPrefix(message)}${formatContext(context)}`)
  },

  error(message: string, context?: Record<string, unknown>): void {
    if (!severityMeetsThreshold(Severity.Error, minimumLogLevel)) return
    writeStderr(`[${logPrefix}] ERROR: ${stripPrefix(message)}${formatContext(context)}`)
  },
}

// ─── Structured JSON Logger (Production-grade) ─────────────────────────────

/**
 * Get active trace context from the OTel API for log correlation.
 * Returns traceId and spanId if a span is active, otherwise undefined.
 */
function getActiveTraceContext(): { traceId?: string; spanId?: string } {
  try {
    const activeSpan = otelTrace.getActiveSpan()
    if (activeSpan) {
      const ctx = activeSpan.spanContext()
      return { traceId: ctx.traceId, spanId: ctx.spanId }
    }
  } catch {
    // OTel not available or no active span — expected
  }
  return {}
}

/**
 * Structured JSON logger — emits newline-delimited JSON (NDJSON) suitable
 * for production log aggregation systems (ELK, Datadog, CloudWatch, etc.).
 *
 * Every log entry includes:
 * - ISO timestamp
 * - Log level
 * - Message
 * - Active traceId/spanId (if OTel tracing is active)
 * - SDK prefix tag
 * - Redacted structured context
 */
export const jsonLogger: Logger = {
  debug(message: string, context?: Record<string, unknown>): void {
    if (!severityMeetsThreshold(Severity.Debug, minimumLogLevel)) return
    emitJsonLog('debug', message, context)
  },

  info(message: string, context?: Record<string, unknown>): void {
    if (!severityMeetsThreshold(Severity.Info, minimumLogLevel)) return
    emitJsonLog('info', message, context)
  },

  warn(message: string, context?: Record<string, unknown>): void {
    if (!severityMeetsThreshold(Severity.Warning, minimumLogLevel)) return
    emitJsonLog('warn', message, context)
  },

  error(message: string, context?: Record<string, unknown>): void {
    if (!severityMeetsThreshold(Severity.Error, minimumLogLevel)) return
    emitJsonLog('error', message, context)
  },
}

function emitJsonLog(
  level: 'debug' | 'info' | 'warn' | 'error',
  message: string,
  context?: Record<string, unknown>,
): void {
  const trace = getActiveTraceContext()

  const entry: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    level,
    logger: logPrefix,
    message: stripPrefix(message),
  }

  // Inject trace correlation if available
  if (trace.traceId) entry['trace.id'] = trace.traceId
  if (trace.spanId) entry['span.id'] = trace.spanId

  // Merge redacted context — bounded so a single oversized log entry can't
  // OOM the process.
  if (context && Object.keys(context).length > 0) {
    try {
      const safe = redact(context) as Record<string, unknown>
      const serialized = JSON.stringify(safe)
      if (serialized.length > MAX_LOG_CONTEXT_BYTES) {
        entry['context'] = '[truncated]'
        entry['contextSize'] = serialized.length
      } else {
        entry['context'] = safe
      }
    } catch {
      entry['context'] = '[unserializable]'
    }
  }

  const writer = level === 'error' || level === 'warn' ? writeStderr : writeStdout

  try {
    writer(JSON.stringify(entry))
  } catch {
    // Fallback if JSON.stringify fails on the entry itself
    writer(`{"timestamp":"${entry.timestamp}","level":"${level}","message":"${message}","error":"log_serialization_failed"}`)
  }
}

// ─── Log Format Configuration ───────────────────────────────────────────────

export type LogFormat = 'text' | 'json'

let currentLogFormat: LogFormat = 'text'

/**
 * Set the log output format.
 * 'text' = Sentry-style prefixed console output (default, good for dev)
 * 'json' = NDJSON structured output (production, log aggregation)
 */
export function setLogFormat(format: LogFormat): void {
  currentLogFormat = format
  activeLogger = format === 'json' ? jsonLogger : consoleLogger
}

/**
 * Get the current log format.
 */
export function getLogFormat(): LogFormat {
  return currentLogFormat
}

// ─── Active Logger Management ───────────────────────────────────────────────

let activeLogger: Logger = consoleLogger

/**
 * Replace the active logger with a custom implementation.
 * Pass undefined/null to restore the default console logger.
 */
export function setLogger(logger: Logger | undefined | null): void {
  activeLogger = logger ?? (currentLogFormat === 'json' ? jsonLogger : consoleLogger)
}

/**
 * Get the active logger instance.
 */
export function getLogger(): Logger {
  return activeLogger
}
