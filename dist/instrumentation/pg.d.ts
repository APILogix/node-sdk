/**
 * PostgreSQL Instrumentation — OpenTelemetry auto-instrumentation
 * wrapped with Pulse SDK guards and remote config support.
 *
 * Features:
 * - Query spans with operation name, table, and database
 * - Parameterized query capture (configurable via captureParams)
 * - Prepared statement support
 * - Connection pool monitoring (pool.total, pool.idle, pool.waiting)
 * - Rows affected tracking via responseHook
 * - Error tracking with query context
 */
import { PgInstrumentation as OTelPgInstrumentation } from '@opentelemetry/instrumentation-pg';
import type { PrivacyCaptureConfig } from '../types/config.js';
export interface PgInstrumentationOptions {
    enabled: boolean;
    captureQueries?: boolean;
    captureParams?: boolean;
    requireParentSpan?: boolean;
    ignoreConnectSpans?: boolean;
    instrumentPool?: boolean;
}
/**
 * Patch pg.Pool.prototype.connect to capture connection acquisition wait time
 * and pool saturation metrics (total, idle, waiting).
 */
export declare function patchPgPoolConnectOnce(): void;
export declare function createPgInstrumentation(enabled: boolean, mergedOptions?: Partial<PgInstrumentationOptions>, captureConfig?: PrivacyCaptureConfig): OTelPgInstrumentation | null;
export interface PgSpanAttributes {
    'db.system': 'postgresql';
    'db.name': string;
    'db.operation': string;
    'db.sql.table'?: string;
    'db.statement'?: string;
    'db.rows_affected'?: number;
}
export { OTelPgInstrumentation };
export default createPgInstrumentation;
