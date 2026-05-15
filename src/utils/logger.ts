/**
 * SDK Logger — Sentry-style debug logging.
 *
 * When `debug: true` is set in SDK options:
 *   - All SDK internal messages are printed via console.log/console.warn/console.error
 *   - Structured context is JSON-stringified and printed alongside
 *
 * When `debug: false` (default):
 *   - Only warnings and errors are printed
 *   - Debug/info messages are silenced for zero noise in production
 *
 * PII redaction is always applied regardless of debug mode.
 */

import { SDKError } from '../core/errors.js'
import { Severity, type SeverityLevel, severityMeetsThreshold } from '../types/severity.js'

export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void
  info(message: string, context?: Record<string, unknown>): void
  warn(message: string, context?: Record<string, unknown>): void
  error(message: string, context?: Record<string, unknown>): void
}

// ─── Configuration ──────────────────────────────────────────────────────────

let debugMode = false
let logPrefix = 'Pulse'
let minimumLogLevel: SeverityLevel = Severity.Warning

/**
 * Enable or disable debug logging globally.
 * Called during SDK initialization based on `options.debug`.
 */
export function setDebugMode(enabled: boolean): void {
  debugMode = enabled
  minimumLogLevel = enabled ? Severity.Debug : Severity.Warning
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

function formatContext(context?: Record<string, unknown>): string {
  if (!context || Object.keys(context).length === 0) return ''

  try {
    const safe = redact(context) as Record<string, unknown>
    return ' ' + JSON.stringify(safe)
  } catch {
    return ' [unserializable context]'
  }
}

// ─── Console Logger (Sentry-style) ─────────────────────────────────────────

export const consoleLogger: Logger = {
  debug(message: string, context?: Record<string, unknown>): void {
    if (!debugMode && !severityMeetsThreshold(Severity.Debug, minimumLogLevel)) return
    if (!severityMeetsThreshold(Severity.Debug, minimumLogLevel)) return
    console.log(`[${logPrefix}] DEBUG: ${message}${formatContext(context)}`)
  },

  info(message: string, context?: Record<string, unknown>): void {
    if (!severityMeetsThreshold(Severity.Info, minimumLogLevel)) return
    console.log(`[${logPrefix}] INFO: ${message}${formatContext(context)}`)
  },

  warn(message: string, context?: Record<string, unknown>): void {
    // Warnings always print — they indicate potential issues
    if (!severityMeetsThreshold(Severity.Warning, minimumLogLevel)) return
    console.warn(`[${logPrefix}] WARN: ${message}${formatContext(context)}`)
  },

  error(message: string, context?: Record<string, unknown>): void {
    // Errors always print — they indicate real failures
    if (!severityMeetsThreshold(Severity.Error, minimumLogLevel)) return
    console.error(`[${logPrefix}] ERROR: ${message}${formatContext(context)}`)
  },
}

// ─── Active Logger Management ───────────────────────────────────────────────

let activeLogger: Logger = consoleLogger

/**
 * Replace the active logger with a custom implementation.
 * Pass undefined/null to restore the default console logger.
 */
export function setLogger(logger: Logger | undefined | null): void {
  activeLogger = logger ?? consoleLogger
}

/**
 * Get the active logger instance.
 */
export function getLogger(): Logger {
  return activeLogger
}
