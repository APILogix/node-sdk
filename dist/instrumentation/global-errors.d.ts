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
export declare function setupGlobalErrorHandlers(): void;
/**
 * Remove all SDK global error handlers and reset state.
 * Called during SDK shutdown to prevent listener leaks across reinit cycles.
 */
export declare function resetGlobalErrorHandlers(): void;
//# sourceMappingURL=global-errors.d.ts.map