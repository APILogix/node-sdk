/**
 * Drizzle ORM Instrumentation — zero-overhead auto-instrumentation and logger
 * integration for Drizzle ORM.
 *
 * Provides:
 * - LynkTraceDrizzleLogger: Drop-in logger implementing Drizzle's Logger interface
 * - Auto-instrumentation wrapper for Drizzle database query executions
 */
import type { PrivacyCaptureConfig } from '../types/config.js';
export interface DrizzleInstrumentationOptions {
    enabled: boolean;
    captureQueries?: boolean;
    captureParams?: boolean;
}
/**
 * Drop-in logger for Drizzle ORM:
 * const db = drizzle(client, { logger: new LynkTraceDrizzleLogger() });
 */
export declare class LynkTraceDrizzleLogger {
    logQuery(query: string, params: unknown[]): void;
}
export declare function createDrizzleInstrumentation(enabled: boolean, _options?: Partial<DrizzleInstrumentationOptions>, _captureConfig?: PrivacyCaptureConfig): {
    enable: () => void;
    disable: () => void;
    teardown: () => void;
    logger: LynkTraceDrizzleLogger;
} | null;
