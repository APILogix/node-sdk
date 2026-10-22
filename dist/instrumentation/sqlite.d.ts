/**
 * SQLite Instrumentation — auto-instrumentation for better-sqlite3 and sqlite3.
 *
 * Engineered with high-performance monotonic timing (process.hrtime.bigint)
 * to ensure near-zero overhead on synchronous in-memory and embedded SQLite calls.
 */
import type { PrivacyCaptureConfig } from '../types/config.js';
export interface SQLiteInstrumentationOptions {
    enabled: boolean;
    captureQueries?: boolean;
    captureParams?: boolean;
}
export declare function createSQLiteInstrumentation(enabled: boolean, options?: Partial<SQLiteInstrumentationOptions>, _captureConfig?: PrivacyCaptureConfig): {
    enable: () => void;
    disable: () => void;
    teardown: () => void;
} | null;
