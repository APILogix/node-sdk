/**
 * Apache Cassandra / ScyllaDB Instrumentation — auto-instrumentation for
 * the official DataStax cassandra-driver.
 *
 * Captures:
 * - CQL execution timing (client.execute)
 * - CQL batch operations (client.batch)
 * - Sanitized CQL statement
 * - Target keyspace and consistency level
 * - Coordinator node IP and rows returned
 */
import type { PrivacyCaptureConfig } from '../types/config.js';
export interface CassandraInstrumentationOptions {
    enabled: boolean;
    captureQueries?: boolean;
    captureParams?: boolean;
}
export declare function createCassandraInstrumentation(enabled: boolean, options?: Partial<CassandraInstrumentationOptions>, _captureConfig?: PrivacyCaptureConfig): {
    enable: () => void;
    disable: () => void;
    teardown: () => void;
} | null;
