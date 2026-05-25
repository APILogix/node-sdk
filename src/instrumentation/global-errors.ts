/**
 * Global error handlers — captures unhandled errors and rejections.
 * Now driven by remote config errors.* section.
 *
 * Reads from ConfigManager to respect:
 *   errors.captureUnhandledRejections — attach unhandledRejection handler
 *   errors.captureUncaughtExceptions — attach uncaughtException handler
 *   errors.captureConsoleErrors — wrap console.error to create error events
 *   errors.stackTraceLimit — override Error.stackTraceLimit
 *
 * On uncaughtException: captures the error and attempts to flush pending events.
 * Does NOT call process.exit — the SDK should never force-terminate the host process.
 *
 * On unhandledRejection: captures the error and continues
 * (rejections don't crash the process by default in modern Node.js).
 */

import { captureError } from "../capture/captureError.js"
import { toError } from "../core/errors.js"
import { getLogger } from "../utils/logger.js"
import { ERROR_DEFAULTS } from "../constants/internal-defaults.js"
import type { ErrorsConfig } from "../types/config.js"

let registered = false

// Store handler references for proper cleanup
let uncaughtHandler: ((err: Error) => void) | null = null
let rejectionHandler: ((reason: unknown) => void) | null = null
let originalConsoleError: (typeof console.error) | null = null
let consoleErrorWrapped = false
let originalStackTraceLimit: number | undefined = undefined

/**
 * Snapshot of the current error-handling defaults. Returns a fresh object on
 * every call so callers can mutate the result without affecting the frozen
 * source-of-truth in `ERROR_DEFAULTS`.
 *
 * Behaviour used to come from `config.errors`, but the wire schema dropped
 * that block — these knobs are SDK opinions, not tenant-level controls.
 */
function getErrorsConfig(): ErrorsConfig {
  return {
    captureUnhandledRejections: ERROR_DEFAULTS.captureUnhandledRejections,
    captureUncaughtExceptions: ERROR_DEFAULTS.captureUncaughtExceptions,
    captureConsoleErrors: ERROR_DEFAULTS.captureConsoleErrors,
    stackTraceLimit: ERROR_DEFAULTS.stackTraceLimit,
    attachSourceContext: ERROR_DEFAULTS.attachSourceContext,
    grouping: { ...ERROR_DEFAULTS.grouping },
  }
}

/**
 * Register process-level error handlers based on remote config.
 *
 * Idempotent: if already registered, this is a no-op so a second call from
 * a re-init path before reset doesn't stack listeners.
 *
 * Safe-by-default semantics:
 *   - Process listeners are tracked by reference for clean removal.
 *   - console.error wrapper preserves the prior implementation so the
 *     restore path returns the slot to whatever the host had before us.
 *   - Error.stackTraceLimit is captured before override so we can restore.
 */
export function setupGlobalErrorHandlers() {
  if (registered) return
  registered = true

  const errorsConfig = getErrorsConfig()
  const logger = getLogger()

  // ─── Stack Trace Limit Override ──────────────────────────────────────
  if (errorsConfig.stackTraceLimit) {
    originalStackTraceLimit = Error.stackTraceLimit
    Error.stackTraceLimit = errorsConfig.stackTraceLimit
    logger.debug(`Error.stackTraceLimit set to ${errorsConfig.stackTraceLimit}`)
  }

  // ─── Uncaught Exception Handler ─────────────────────────────────────
  if (errorsConfig.captureUncaughtExceptions !== false) {
    uncaughtHandler = (err: Error) => {
      try {
        captureError(err, { mechanism: "uncaughtException" })
      } catch {
        // captureError should never throw, but we double-guard here
      }

      logger.error("Uncaught exception detected — attempting to flush SDK events", {
        error: err.message,
        stack: err.stack,
      })

      // Attempt a best-effort async flush. This is fire-and-forget
      // because Node.js will likely terminate after uncaughtException.
      // We do NOT call process.exit() — the SDK must never force-kill
      // the host process. This matches Sentry SDK behavior.
      import("../transport/batcher.js")
        .then(({ flush }) => flush())
        .catch(() => {
          // If flush fails (e.g., SDK not initialized), swallow silently
        })
    }

    process.on("uncaughtException", uncaughtHandler)
    logger.debug('Registered uncaughtException handler')
  }

  // ─── Unhandled Rejection Handler ────────────────────────────────────
  if (errorsConfig.captureUnhandledRejections !== false) {
    rejectionHandler = (reason: unknown) => {
      try {
        captureError(toError(reason), { mechanism: "unhandledRejection" })
      } catch {
        // Isolated — never crash the host
      }
    }

    process.on("unhandledRejection", rejectionHandler)
    logger.debug('Registered unhandledRejection handler')
  }

  // ─── Console Error Wrapping ─────────────────────────────────────────
  if (errorsConfig.captureConsoleErrors) {
    wrapConsoleError()
    logger.debug('console.error wrapped for error capture')
  }
}

/**
 * Wrap console.error to generate error events for every call.
 * Marks the wrapper so we can detect it on restore and skip restoring if
 * something else wrapped on top of us.
 */
const CONSOLE_ERROR_MARKER = Symbol.for('pulse-sdk.global-errors.console-error-wrapper')

interface MarkedConsoleError {
  (...args: unknown[]): void
  [CONSOLE_ERROR_MARKER]?: true
}

function wrapConsoleError(): void {
  if (consoleErrorWrapped) return
  consoleErrorWrapped = true
  originalConsoleError = console.error

  const wrapped: MarkedConsoleError = (...args: unknown[]) => {
    // Always call the original first
    if (originalConsoleError) {
      originalConsoleError.apply(console, args)
    }

    // Create an error event from the console.error call
    try {
      const message = args.map(a => {
        if (a instanceof Error) return a.message
        if (typeof a === 'string') return a
        try { return JSON.stringify(a) } catch { return String(a) }
      }).join(' ')

      const error = args.find(a => a instanceof Error) as Error | undefined
      captureError(error ?? new Error(message), {
        mechanism: 'console.error',
        severity: 'error',
      } as Record<string, unknown>)
    } catch {
      // Never crash the host from console.error wrapping
    }
  }
  wrapped[CONSOLE_ERROR_MARKER] = true
  console.error = wrapped
}

/**
 * Remove all SDK global error handlers and reset state.
 * Called during SDK shutdown to prevent listener leaks across reinit cycles.
 *
 * Idempotent: safe to call multiple times. Safe to call before
 * setupGlobalErrorHandlers (no-op).
 */
export function resetGlobalErrorHandlers() {
  if (uncaughtHandler) {
    process.removeListener("uncaughtException", uncaughtHandler)
    uncaughtHandler = null
  }
  if (rejectionHandler) {
    process.removeListener("unhandledRejection", rejectionHandler)
    rejectionHandler = null
  }

  // Restore console.error only if our wrapper is still the active method.
  // If the host (or another monitoring SDK) wrapped on top of us, leave
  // their wrapper in place — they own the restore path.
  if (consoleErrorWrapped && originalConsoleError) {
    const current = console.error as MarkedConsoleError
    if (current && current[CONSOLE_ERROR_MARKER] === true) {
      console.error = originalConsoleError
    }
    originalConsoleError = null
    consoleErrorWrapped = false
  }

  // Restore stack trace limit
  if (originalStackTraceLimit !== undefined) {
    Error.stackTraceLimit = originalStackTraceLimit
    originalStackTraceLimit = undefined
  }

  registered = false
}
