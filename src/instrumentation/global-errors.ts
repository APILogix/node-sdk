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
import { ConfigManager } from "../core/config-manager.js"
import type { ErrorsConfig } from "../types/config.js"

let registered = false

// Store handler references for proper cleanup
let uncaughtHandler: ((err: Error) => void) | null = null
let rejectionHandler: ((reason: unknown) => void) | null = null
let originalConsoleError: (typeof console.error) | null = null
let consoleErrorWrapped = false
let originalStackTraceLimit: number | undefined = undefined

/**
 * Resolve errors config from remote config with safe defaults.
 */
function getErrorsConfig(): ErrorsConfig {
  try {
    const configManager = ConfigManager.getInstance()
    return configManager.getConfig().errors
  } catch {
    // Fallback if ConfigManager not initialized
    return {
      captureUnhandledRejections: true,
      captureUncaughtExceptions: true,
      captureConsoleErrors: false,
      stackTraceLimit: 50,
      attachSourceContext: true,
      grouping: { enabled: true, normalizePaths: true },
    }
  }
}

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
 */
function wrapConsoleError(): void {
  if (consoleErrorWrapped) return
  consoleErrorWrapped = true
  originalConsoleError = console.error

  console.error = (...args: unknown[]) => {
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
}

/**
 * Remove all SDK global error handlers and reset state.
 * Called during SDK shutdown to prevent listener leaks across reinit cycles.
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

  // Restore console.error
  if (consoleErrorWrapped && originalConsoleError) {
    console.error = originalConsoleError
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
