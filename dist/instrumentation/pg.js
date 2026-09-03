/**
 * PostgreSQL Instrumentation — OpenTelemetry auto-instrumentation
 * wrapped with Pulse SDK guards and remote config support.
 *
 * Features:
 * - Query spans with operation name, table, and database
 * - Parameterized query capture (configurable via captureParams)
 * - Prepared statement support
 * - Connection pool monitoring
 * - Error tracking with query context
 */
import { PgInstrumentation as OTelPgInstrumentation } from '@opentelemetry/instrumentation-pg';
export function createPgInstrumentation(enabled, mergedOptions, captureConfig) {
    if (!enabled) {
        return null;
    }
    const captureBody = captureConfig?.body ?? false;
    const instrumentationOptions = {
        enabled: true,
        enhancedDatabaseReporting: mergedOptions?.captureQueries ?? captureBody,
        addSqlCommenterCommentToQueries: false,
    };
    return new OTelPgInstrumentation(instrumentationOptions);
}
export { OTelPgInstrumentation };
export default createPgInstrumentation;
