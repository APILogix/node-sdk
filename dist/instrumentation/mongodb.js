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
export function createMongoDBInstrumentation(enabled, mergedOptions, captureConfig) {
    if (!enabled) {
        return null;
    }
    const captureBody = captureConfig?.body ?? false;
    const instrumentationOptions = {
        enabled: true,
        enhancedDatabaseReporting: mergedOptions?.enhancedDatabaseReporting ?? false,
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
    return new OTelMongoDBInstrumentation(instrumentationOptions);
}
export { OTelMongoDBInstrumentation };
export default createMongoDBInstrumentation;
//# sourceMappingURL=mongodb.js.map