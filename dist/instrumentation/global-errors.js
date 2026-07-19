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
import { captureError } from "../capture/captureError.js";
import { toError } from "../core/errors.js";
import { getLogger } from "../utils/logger.js";
import { ERROR_DEFAULTS } from "../constants/internal-defaults.js";
import { crashFlush } from "../core/lifecycle.js";
import { isOtelInstrumentationError } from "./http-lifecycle-guard.js";
import { SecurityScrubber } from "../processors/security-scrubber.js";
import { Severity } from "../types/severity.js";
let registered = false;
// Store handler references for proper cleanup
let uncaughtHandler = null;
let rejectionHandler = null;
let originalConsoleError = null;
let consoleErrorWrapped = false;
let originalStackTraceLimit = undefined;
/**
 * Snapshot of the current error-handling defaults. Returns a fresh object on
 * every call so callers can mutate the result without affecting the frozen
 * source-of-truth in `ERROR_DEFAULTS`.
 *
 * Behaviour used to come from `config.errors`, but the wire schema dropped
 * that block — these knobs are SDK opinions, not tenant-level controls.
 */
function getErrorsConfig() {
    return {
        captureUnhandledRejections: ERROR_DEFAULTS.captureUnhandledRejections,
        captureUncaughtExceptions: ERROR_DEFAULTS.captureUncaughtExceptions,
        captureConsoleErrors: ERROR_DEFAULTS.captureConsoleErrors,
        stackTraceLimit: ERROR_DEFAULTS.stackTraceLimit,
        attachSourceContext: ERROR_DEFAULTS.attachSourceContext,
        grouping: { ...ERROR_DEFAULTS.grouping },
    };
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
    if (registered)
        return;
    registered = true;
    const errorsConfig = getErrorsConfig();
    const logger = getLogger();
    // ─── Stack Trace Limit Override ──────────────────────────────────────
    if (errorsConfig.stackTraceLimit) {
        originalStackTraceLimit = Error.stackTraceLimit;
        Error.stackTraceLimit = errorsConfig.stackTraceLimit;
        logger.debug(`Error.stackTraceLimit set to ${errorsConfig.stackTraceLimit}`);
    }
    // ─── Uncaught Exception Handler ─────────────────────────────────────
    if (errorsConfig.captureUncaughtExceptions !== false) {
        uncaughtHandler = (err) => {
            // ─── OTel Instrumentation Lifecycle Error Filter ──────────────
            // OTel's HTTP instrumentation has a known race condition where
            // socket destruction before response formation causes a TypeError
            // in internal utility functions. These are non-fatal lifecycle
            // artifacts of the instrumentation layer, NOT application errors.
            //
            // Logging at warn level (not triggering crash-flush) is correct
            // because:
            // 1. The span has already been closed by OTel's own guard
            // 2. No user data is lost — the request was already aborted
            // 3. Crash-flushing for these would mask real application crashes
            if (isOtelInstrumentationError(err)) {
                logger.debug('OTel instrumentation lifecycle error (non-fatal, suppressed)', {
                    error: err.message,
                    hint: 'Socket destroyed before HTTP response — known OTel race condition',
                });
                return;
            }
            try {
                captureError(err, { mechanism: "uncaughtException" });
            }
            catch {
                // captureError should never throw, but we double-guard here
            }
            logger.error("Uncaught exception detected — attempting to flush SDK events", {
                error: err.message,
                stack: err.stack,
            });
            // Use the bounded crashFlush() to give the transport a real chance
            // to drain the error event before the process terminates. Unlike the
            // previous fire-and-forget dynamic import, crashFlush() is bounded
            // by a hard timeout (2s default) so the process won't hang.
            crashFlush().catch(() => {
                // Best-effort — if flush fails, we've already captured the error
            });
        };
        process.on("uncaughtException", uncaughtHandler);
        logger.debug('Registered uncaughtException handler');
    }
    // ─── Unhandled Rejection Handler ────────────────────────────────────
    if (errorsConfig.captureUnhandledRejections !== false) {
        rejectionHandler = (reason) => {
            try {
                captureError(toError(reason), { mechanism: "unhandledRejection" });
            }
            catch {
                // Isolated — never crash the host
            }
        };
        process.on("unhandledRejection", rejectionHandler);
        logger.debug('Registered unhandledRejection handler');
    }
    // ─── Console Error Wrapping ─────────────────────────────────────────
    if (errorsConfig.captureConsoleErrors) {
        wrapConsoleError();
        logger.debug('console.error wrapped for error capture');
    }
}
/**
 * Wrap console.error to generate error events for every call.
 * Marks the wrapper so we can detect it on restore and skip restoring if
 * something else wrapped on top of us.
 */
const CONSOLE_ERROR_MARKER = Symbol.for('pulse-sdk.global-errors.console-error-wrapper');
function wrapConsoleError() {
    if (consoleErrorWrapped)
        return;
    consoleErrorWrapped = true;
    originalConsoleError = console.error;
    const wrapped = (...args) => {
        // Always call the original first
        if (originalConsoleError) {
            originalConsoleError.apply(console, args);
        }
        // Re-entry guard. If captureError below logs anything via the SDK
        // logger (which now writes directly to process.stderr, not
        // console.error, so this is mostly defensive), or if a plugin in the
        // pipeline calls console.error during processing, we'd recurse here.
        // The flag is module-local so unrelated user console.error calls are
        // unaffected.
        if (consoleErrorReentry)
            return;
        consoleErrorReentry = true;
        // Create an error event from the console.error call
        try {
            // Scrub args before stringifying — `console.error('creds', { password })`
            // must never exfiltrate secrets into the error message. Error instances
            // pass through untouched (scrubValue would strip their non-enumerable
            // message/stack); their message/stack go through the pipeline-level
            // scrub before transport. Fail-open when the scrubber isn't
            // initialized yet for the same reason.
            const scrubber = SecurityScrubber.getInstance();
            const scrubbedArgs = scrubber
                ? args.map(a => (a instanceof Error ? a : scrubber.scrubValue(a)))
                : args;
            const message = scrubbedArgs.map(a => {
                if (a instanceof Error)
                    return a.message;
                if (typeof a === 'string')
                    return a;
                try {
                    return JSON.stringify(a);
                }
                catch {
                    return String(a);
                }
            }).join(' ');
            const error = scrubbedArgs.find(a => a instanceof Error);
            captureError(error ?? new Error(message), {
                mechanism: 'console.error',
                severity: Severity.Error,
            });
        }
        catch {
            // Never crash the host from console.error wrapping
        }
        finally {
            consoleErrorReentry = false;
        }
    };
    wrapped[CONSOLE_ERROR_MARKER] = true;
    console.error = wrapped;
}
/**
 * Re-entry guard for the console.error wrapper. Set to true while we're
 * inside `captureError` for a console.error call, prevents the SDK
 * accidentally recursing if any code inside the capture path calls
 * console.error itself.
 */
let consoleErrorReentry = false;
/**
 * Remove all SDK global error handlers and reset state.
 * Called during SDK shutdown to prevent listener leaks across reinit cycles.
 *
 * Idempotent: safe to call multiple times. Safe to call before
 * setupGlobalErrorHandlers (no-op).
 */
export function resetGlobalErrorHandlers() {
    if (uncaughtHandler) {
        process.removeListener("uncaughtException", uncaughtHandler);
        uncaughtHandler = null;
    }
    if (rejectionHandler) {
        process.removeListener("unhandledRejection", rejectionHandler);
        rejectionHandler = null;
    }
    // Restore console.error only if our wrapper is still the active method.
    // If the host (or another monitoring SDK) wrapped on top of us, leave
    // their wrapper in place — they own the restore path.
    if (consoleErrorWrapped && originalConsoleError) {
        const current = console.error;
        if (current && current[CONSOLE_ERROR_MARKER] === true) {
            console.error = originalConsoleError;
        }
        originalConsoleError = null;
        consoleErrorWrapped = false;
    }
    // Restore stack trace limit
    if (originalStackTraceLimit !== undefined) {
        Error.stackTraceLimit = originalStackTraceLimit;
        originalStackTraceLimit = undefined;
    }
    registered = false;
}
//# sourceMappingURL=global-errors.js.map