/**
 * Global error handlers — captures unhandled errors and rejections.
 *
 * On uncaughtException: captures the error and attempts to flush pending events.
 * Does NOT call process.exit — the SDK should never force-terminate the host process.
 * The host application's own exception handler or Node.js default behavior controls exit.
 *
 * On unhandledRejection: captures the error and continues
 * (rejections don't crash the process by default in modern Node.js).
 */

import { captureError } from "../capture/captureError.js"
import { toError } from "../core/errors.js"
import { getLogger } from "../utils/logger.js"

let registered = false

// Store handler references for proper cleanup
let uncaughtHandler: ((err: Error) => void) | null = null
let rejectionHandler: ((reason: unknown) => void) | null = null

export function setupGlobalErrorHandlers() {
  if (registered) return
  registered = true

  uncaughtHandler = (err: Error) => {
    const logger = getLogger()

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

  rejectionHandler = (reason: unknown) => {
    try {
      captureError(toError(reason), { mechanism: "unhandledRejection" })
    } catch {
      // Isolated — never crash the host
    }
  }

  process.on("uncaughtException", uncaughtHandler)
  process.on("unhandledRejection", rejectionHandler)
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
  registered = false
}
