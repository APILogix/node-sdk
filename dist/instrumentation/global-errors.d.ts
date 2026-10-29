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
export declare const CAPTURED_ERROR_MARKER: unique symbol;
/**
 * Returns whether the SDK is actively executing an emergency crash flush sequence.
 */
export declare function isProcessCrashing(): boolean;
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
export declare function setupGlobalErrorHandlers(): void;
/**
 * Remove all SDK global error handlers and reset state.
 * Called during SDK shutdown to prevent listener leaks across reinit cycles.
 *
 * Idempotent: safe to call multiple times. Safe to call before
 * setupGlobalErrorHandlers (no-op).
 */
export declare function resetGlobalErrorHandlers(): void;
