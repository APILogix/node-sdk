/**
 * MySQL Instrumentation — OpenTelemetry auto-instrumentation
 * wrapped with LynkTrace SDK guards and remote config support.
 *
 * Features:
 * - Query spans with operation name, table, and database
 * - Prepared statement support
 * - Connection pool monitoring
 * - Error tracking with query context
 * - Transaction instrumentation
 */
import { MySQL2Instrumentation as OTelMySQL2Instrumentation } from '@opentelemetry/instrumentation-mysql2';
import type { PrivacyCaptureConfig } from '../types/config.js';
export interface MySQLInstrumentationOptions {
    enabled: boolean;
    captureQueries?: boolean;
}
export declare function createMySQLInstrumentation(enabled: boolean, mergedOptions?: Partial<MySQLInstrumentationOptions>, captureConfig?: PrivacyCaptureConfig): OTelMySQL2Instrumentation | null;
export interface MySQLSpanAttributes {
    'db.system': 'mysql';
    'db.name': string;
    'db.operation': string;
    'db.sql.table'?: string;
    'db.statement'?: string;
}
export { OTelMySQL2Instrumentation };
export default createMySQLInstrumentation;
