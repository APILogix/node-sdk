/**
 * Global error handlers. Remote features/killswitches decide whether the
 * subsystem runs; implementation mechanics come from internal constants.
 *
 * On uncaughtException: captures the error and attempts to flush pending events.
 * Does NOT call process.exit — the SDK should never force-terminate the host process.
 *
 * On unhandledRejection: captures the error and continues
 * (rejections don't crash the process by default in modern Node.js).
 */

import { captureException } from "../capture/captureException.js"
import { captureMessage } from "../capture/captureMessage.js"
import { toError } from "../core/errors.js"
import { getLogger } from "../utils/logger.js"
import { ERROR_DEFAULTS } from "../constants/internal-defaults.js"
import { emergencyFlush } from "../core/lifecycle.js"
import { isOtelInstrumentationError } from "./http-lifecycle-guard.js"
import { SecurityScrubber } from "../processors/security-scrubber.js"
import { Severity } from "../types/severity.js"
import { createContextStore, withContext, getRequestContext } from "../core/context.js"
import { client } from "../core/client.js"
import { ConfigManager } from "../core/config-manager.js"

let registered = false
let isCrashing = false

/**
 * Returns whether the SDK is actively executing an emergency crash flush sequence.
 */
export function isProcessCrashing(): boolean {
  return isCrashing
}

// Store handler references for proper cleanup
let uncaughtHandler: ((err: Error) => void) | null = null
let rejectionHandler: ((reason: unknown) => void) | null = null
let originalConsoleError: (typeof console.error) | null = null
let consoleErrorWrapped = false

/** Error-handler mechanics read remote config.errors when provided. */
function getErrorsConfig(): {
  readonly captureUnhandledRejections: boolean
  readonly captureUncaughtExceptions: boolean
  readonly captureConsoleErrors: boolean
  readonly stackTraceLimit: number
  readonly attachSourceContext: boolean
  readonly grouping: { readonly enabled: boolean; readonly normalizePaths: boolean }
} {
  const remoteErrors = ConfigManager.getCurrent()?.getConfig()?.errors
  if (remoteErrors) {
    return {
      captureUnhandledRejections: remoteErrors.captureUnhandledRejections ?? ERROR_DEFAULTS.captureUnhandledRejections,
      captureUncaughtExceptions: remoteErrors.captureUncaughtExceptions ?? ERROR_DEFAULTS.captureUncaughtExceptions,
      captureConsoleErrors: remoteErrors.captureConsoleErrors ?? ERROR_DEFAULTS.captureConsoleErrors,
      stackTraceLimit: remoteErrors.stackTraceLimit ?? ERROR_DEFAULTS.stackTraceLimit,
      attachSourceContext: remoteErrors.attachSourceContext ?? ERROR_DEFAULTS.attachSourceContext,
      grouping: remoteErrors.grouping ?? ERROR_DEFAULTS.grouping,
    }
  }
  return ERROR_DEFAULTS
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

  // Note: Error.stackTraceLimit is intentionally NOT mutated globally to preserve
  // host application performance and behavior (SEC-11). Stack capture uses
  // localized V8 prepareStackTrace or caller-scoped depth limits.

  // ─── Uncaught Exception Handler ─────────────────────────────────────
  if (errorsConfig.captureUncaughtExceptions !== false) {
    uncaughtHandler = (err: Error) => {
      // ─── Crash Storm / Re-entrancy Guard ─────────────────────────
      if (isCrashing) {
        try {
          process.stderr.write(`[Telemetry] Secondary uncaught exception during crash flush: ${err?.stack || err?.message || err}\n`)
        } catch {}
        return
      }
      isCrashing = true

      // ─── OTel Instrumentation Lifecycle Error Filter ──────────────
      if (isOtelInstrumentationError(err)) {
        isCrashing = false
        logger.debug('OTel instrumentation lifecycle error (non-fatal, suppressed)', {
          error: err.message,
          hint: 'Socket destroyed before HTTP response — known OTel race condition',
        })
        return
      }

      try {
        const store = createContextStore('uncaught', 10, {
          extra: { mechanism: 'uncaughtException', handled: false },
        })
        withContext(store, () => {
          captureException(err, 'fatal')
        })
      } catch (captureErr) {
        try {
          process.stderr.write(`[Telemetry] Failed to capture uncaught exception: ${captureErr}\n`)
        } catch {}
      }

      logger.error("Uncaught exception detected — flushing telemetry before process termination", {
        error: err.message,
        stack: err.stack,
      })

      // Installing an uncaughtException listener suppresses Node's default
      // non-zero termination. Preserve fatal process semantics.
      if (!process.exitCode || process.exitCode === 0) {
        process.exitCode = 1
      }

      const clientOptions = client.options
      // By default, terminate the process after crash flush completes.
      // Callers can opt out explicitly by setting `exitOnUncaughtException: false`.
      const shouldExit = clientOptions?.exitOnUncaughtException !== false
      const crashTimeoutMs = clientOptions?.crashTimeoutMs ?? 2_000
      const onFatalError = clientOptions?.onFatalError
      const targetExitCode = process.exitCode || 1

      // Hard fallback timer — guarantees process exits even if emergencyFlush hangs or deadlocks
      let fallbackTimer: NodeJS.Timeout | undefined
      if (shouldExit) {
        fallbackTimer = setTimeout(() => {
          try {
            process.stderr.write('[Telemetry] Crash flush timeout reached — forcing process termination\n')
          } catch {}
          if (typeof onFatalError === 'function') {
            try { onFatalError(err) } catch {}
          }
          process.exit(targetExitCode)
        }, crashTimeoutMs + 500)
        fallbackTimer.unref?.()
      }

      // Execute bounded crash flush before terminating
      void (async () => {
        try {
          await emergencyFlush(crashTimeoutMs)
        } catch (flushErr) {
          try {
            process.stderr.write(`[Telemetry] Error during crash flush: ${flushErr}\n`)
          } catch {}
        } finally {
          if (fallbackTimer) {
            clearTimeout(fallbackTimer)
            fallbackTimer = undefined
          }
          if (typeof onFatalError === 'function') {
            try { onFatalError(err) } catch {}
          }
          if (shouldExit) {
            // Allow libuv to process pending handle close callbacks (uv_process_endgames) on Windows
            await new Promise(r => setTimeout(r, 30))
            process.exit(targetExitCode)
          } else {
            isCrashing = false
          }
        }
      })()
    }

    process.on("uncaughtException", uncaughtHandler)
    logger.debug('Registered uncaughtException handler')
  }

  // ─── Unhandled Rejection Handler ────────────────────────────────────
  if (errorsConfig.captureUnhandledRejections !== false) {
    rejectionHandler = (reason: unknown) => {
      try {
        const store = createContextStore('unhandled', 10, {
          extra: { mechanism: 'unhandledRejection', handled: false },
        })
        withContext(store, () => {
          captureException(toError(reason), 'error')
        })
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
const CONSOLE_ERROR_MARKER = Symbol.for('lynktrace.global-errors.console-error-wrapper')
const CONSOLE_ERROR_MARKER_LEGACY = Symbol.for('pulse-sdk.global-errors.console-error-wrapper')

const PROCESS_WARNING_PATTERN = /^(?:\(node:\d+\)\s+)?(?:\[[A-Z0-9_-]+\]\s+)?(?:SECURITY\s+)?(?:Warning|DeprecationWarning|ExperimentalWarning):/i

function isProcessWarning(error?: Error, message?: string): boolean {
  if (error && (error.name === 'Warning' || error.name === 'DeprecationWarning' || error.name === 'ExperimentalWarning')) {
    return true
  }
  if (message && PROCESS_WARNING_PATTERN.test(message.trim())) {
    return true
  }
  return false
}

interface MarkedConsoleError {
  (...args: unknown[]): void
  [CONSOLE_ERROR_MARKER]?: true
  [CONSOLE_ERROR_MARKER_LEGACY]?: true
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

    // Re-entry guard. If captureException below logs anything via the SDK
    // logger (which now writes directly to process.stderr, not
    // console.error, so this is mostly defensive), or if a plugin in the
    // pipeline calls console.error during processing, we'd recurse here.
    // The flag is module-local so unrelated user console.error calls are
    // unaffected.
    if (consoleErrorReentry) return
    consoleErrorReentry = true

    // Create an error event from the console.error call
    try {
      // Scrub args before stringifying — `console.error('creds', { password })`
      // must never exfiltrate secrets into the error message. Error instances
      // pass through untouched (scrubValue would strip their non-enumerable
      // message/stack); their message/stack go through transport scrubbing.
      // The scrubber exists before handlers are installed; lifecycle races
      // redact non-Error arguments rather than forwarding them unchanged.
      const scrubber = SecurityScrubber.getInstance()
      const scrubbedArgs = scrubber
        ? args.map(a => (a instanceof Error ? a : scrubber.scrubValue(a)))
        : args.map(a => (a instanceof Error ? a : '[Redacted]'))

      const message = scrubbedArgs.map(a => {
        if (a instanceof Error) return a.message
        if (typeof a === 'string') return a
        try { return JSON.stringify(a) } catch { return String(a) }
      }).join(' ')

      const error = scrubbedArgs.find(a => a instanceof Error) as Error | undefined

      // Route runtime/library process warnings to captureMessage (Severity.Warning)
      // instead of logging an APM application error that taints healthy HTTP 200 requests.
      if (isProcessWarning(error, message)) {
        captureMessage(message, Severity.Warning, {
          mechanism: 'console.error.warning',
          warning: true,
        })
        return
      }

      const store = getRequestContext()
      if (store?.extra) {
        ;(store.extra as Record<string, unknown>).mechanism = 'console.error'
        ;(store.extra as Record<string, unknown>).handled = true
      }
      captureException(error ?? new Error(message), 'error')
    } catch {
      // Never crash the host from console.error wrapping
    } finally {
      consoleErrorReentry = false
    }
  }
  wrapped[CONSOLE_ERROR_MARKER] = true
  wrapped[CONSOLE_ERROR_MARKER_LEGACY] = true
  console.error = wrapped
}

/**
 * Re-entry guard for the console.error wrapper. Set to true while we're
 * inside `captureException` for a console.error call, prevents the SDK
 * accidentally recursing if any code inside the capture path calls
 * console.error itself.
 */
let consoleErrorReentry = false

/**
 * Remove all SDK global error handlers and reset state.
 * Called during SDK shutdown to prevent listener leaks across reinit cycles.
 *
 * Idempotent: safe to call multiple times. Safe to call before
 * setupGlobalErrorHandlers (no-op).
 */
export function resetGlobalErrorHandlers() {
  isCrashing = false
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
    if (current && (current[CONSOLE_ERROR_MARKER] === true || current[CONSOLE_ERROR_MARKER_LEGACY] === true)) {
      console.error = originalConsoleError
    }
    originalConsoleError = null
    consoleErrorWrapped = false
  }

  registered = false
}
