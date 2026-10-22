/**
 * Microsoft SQL Server Instrumentation — auto-instrumentation for
 * tedious and mssql drivers.
 *
 * Captures:
 * - T-SQL query execution timing
 * - Stored procedure and batch executions
 * - Target database name
 * - Sanitized T-SQL query statement
 */
import type { PrivacyCaptureConfig } from '../types/config.js';
export interface MSSQLInstrumentationOptions {
    enabled: boolean;
    captureQueries?: boolean;
    captureParams?: boolean;
}
export declare function createMSSQLInstrumentation(enabled: boolean, options?: Partial<MSSQLInstrumentationOptions>, _captureConfig?: PrivacyCaptureConfig): {
    enable: () => void;
    disable: () => void;
    teardown: () => void;
} | null;
