/**
 * MongoDB Instrumentation — OpenTelemetry auto-instrumentation
 * wrapped with Pulse SDK guards and remote config support.
 *
 * Features:
 * - Command spans with operation name, collection, database
 * - Request/response size tracking
 * - Sharded cluster support
 * - Replica set awareness
 * - Connection pool monitoring
 */
import { MongoDBInstrumentation as OTelMongoDBInstrumentation } from '@opentelemetry/instrumentation-mongodb';
import { context, createContextKey } from '@opentelemetry/api';
export const SUPPRESS_MONGODB_DRIVER_SPANS = createContextKey('pulse-sdk.mongodb.suppress-driver-spans');
export function createMongoDBInstrumentation(enabled, mergedOptions, captureConfig) {
    if (!enabled) {
        return null;
    }
    const captureBody = captureConfig?.body ?? false;
    const instrumentationOptions = {
        enabled: true,
        enhancedDatabaseReporting: mergedOptions?.enhancedDatabaseReporting ?? false,
        ...(mergedOptions?.requireParentSpan !== undefined ? { requireParentSpan: mergedOptions.requireParentSpan } : {}),
        requireParentSpan: mergedOptions?.requireParentSpan ?? false,
        dbStatementSerializer: mergedOptions?.dbStatementSerializer ?? ((command) => {
            if (!captureBody) {
                return '[REDACTED]';
            }
            try {
                return JSON.stringify(command);
            }
            catch {
                return '[UNSERIALIZABLE]';
            }
        }),
    };
    const instrumentation = new OTelMongoDBInstrumentation(instrumentationOptions);
    const originalSkipCheck = instrumentation._checkSkipInstrumentation;
    if (typeof originalSkipCheck === 'function') {
        ;
        instrumentation._checkSkipInstrumentation = function pulseCheckSkipMongoDBInstrumentation(currentSpan) {
            if (context.active().getValue(SUPPRESS_MONGODB_DRIVER_SPANS) === true) {
                return true;
            }
            return originalSkipCheck.call(this, currentSpan);
        };
    }
    return instrumentation;
}
export { OTelMongoDBInstrumentation };
export default createMongoDBInstrumentation;
