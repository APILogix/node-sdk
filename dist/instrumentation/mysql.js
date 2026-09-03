/**
 * MySQL Instrumentation — OpenTelemetry auto-instrumentation
 * wrapped with Pulse SDK guards and remote config support.
 *
 * Features:
 * - Query spans with operation name, table, and database
 * - Prepared statement support
 * - Connection pool monitoring
 * - Error tracking with query context
 * - Transaction instrumentation
 */
import { MySQL2Instrumentation as OTelMySQL2Instrumentation } from '@opentelemetry/instrumentation-mysql2';
export function createMySQLInstrumentation(enabled, mergedOptions, captureConfig) {
    if (!enabled) {
        return null;
    }
    const captureBody = captureConfig?.body ?? false;
    const instrumentationOptions = {
        enabled: true,
        // When captureQueries is false (default), mask query parameters for safety.
        // When captureQueries is true, disable masking to capture full SQL.
        maskStatement: !(mergedOptions?.captureQueries ?? captureBody),
        addSqlCommenterCommentToQueries: false,
    };
    return new OTelMySQL2Instrumentation(instrumentationOptions);
}
export { OTelMySQL2Instrumentation };
export default createMySQLInstrumentation;
