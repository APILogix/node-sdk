/**
 * Compatibility shim.
 *
 * Express tracing is provided by OpenTelemetry ExpressInstrumentation.
 * The legacy middleware remains export-compatible but does not patch response
 * methods, create spans, or capture duplicate request telemetry.
 */
import { getLogger } from '../utils/logger.js';
let warned = false;
export function monitorMiddleware() {
    return function (_req, _res, next) {
        if (!warned) {
            warned = true;
            getLogger().info('Express manual middleware is a no-op; OpenTelemetry owns Express tracing');
        }
        next();
    };
}
//# sourceMappingURL=express.js.map