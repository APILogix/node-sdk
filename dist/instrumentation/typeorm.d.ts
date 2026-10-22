/**
 * TypeORM Instrumentation — auto-instrumentation for TypeORM entities,
 * repositories, and query builders.
 *
 * Captures:
 * - Entity repository operations (find, save, remove, delete, findOne)
 * - Target entity class name
 * - Query builder execution
 * - Logical parent-child linking over underlying database driver spans
 */
import type { PrivacyCaptureConfig } from '../types/config.js';
export interface TypeORMInstrumentationOptions {
    enabled: boolean;
    captureQueries?: boolean;
    captureParams?: boolean;
}
export declare function createTypeORMInstrumentation(enabled: boolean, _options?: Partial<TypeORMInstrumentationOptions>, _captureConfig?: PrivacyCaptureConfig): {
    enable: () => void;
    disable: () => void;
    teardown: () => void;
} | null;
