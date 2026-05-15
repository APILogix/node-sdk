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
import { captureError } from "../capture/captureError.js";
import { toError } from "../core/errors.js";
import { getLogger } from "../utils/logger.js";
let registered = false;
export function setupGlobalErrorHandlers() {
    if (registered)
        return;
    registered = true;
    process.on("uncaughtException", (err) => {
        const logger = getLogger();
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
        // Attempt a best-effort async flush. This is fire-and-forget
        // because Node.js will likely terminate after uncaughtException.
        // We do NOT call process.exit() — the SDK must never force-kill
        // the host process. This matches Sentry SDK behavior.
        import("../transport/batcher.js")
            .then(({ flush }) => flush())
            .catch(() => {
            // If flush fails (e.g., SDK not initialized), swallow silently
        });
    });
    process.on("unhandledRejection", (reason) => {
        try {
            captureError(toError(reason), { mechanism: "unhandledRejection" });
        }
        catch {
            // Isolated — never crash the host
        }
    });
}
/**
 * Reset registration state — for testing only.
 * @internal
 */
export function resetGlobalErrorHandlers() {
    registered = false;
}
//# sourceMappingURL=global-errors.js.map