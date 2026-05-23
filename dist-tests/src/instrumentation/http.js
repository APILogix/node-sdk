/**
 * Compatibility shim.
 *
 * HTTP tracing is owned by OpenTelemetry HttpInstrumentation and
 * UndiciInstrumentation. This function intentionally does not monkey-patch
 * node:http or node:https, preventing duplicate spans and recursive SDK
 * self-instrumentation.
 */
import { getLogger } from '../utils/logger.js';
let instrumented = false;
/**
 * @deprecated HTTP tracing is fully owned by OpenTelemetry HttpInstrumentation.
 * This function is a no-op retained for backward compatibility.
 * Remove calls to this function — OpenTelemetry handles HTTP tracing automatically.
 */
export function instrumentHttpClient() {
    if (instrumented)
        return;
    instrumented = true;
    getLogger().info('HTTP client manual instrumentation skipped; OpenTelemetry owns HTTP tracing');
}
export function resetHttpInstrumentation() {
    instrumented = false;
}
