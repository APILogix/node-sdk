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
import type { PrivacyCaptureConfig } from '../types/config.js';
export declare const SUPPRESS_MONGODB_DRIVER_SPANS: symbol;
export declare const SUPPRESS_MONGODB_DRIVER_SPANS_LEGACY: symbol;
export interface MongoDBInstrumentationOptions {
    enabled: boolean;
    enhancedDatabaseReporting?: boolean;
    dbStatementSerializer?: (command: Record<string, unknown>) => string;
    addStatementAttribute?: boolean;
    captureCommandArguments?: boolean;
    requireParentSpan?: boolean;
}
export declare function createMongoDBInstrumentation(enabled: boolean, mergedOptions?: Partial<MongoDBInstrumentationOptions>, captureConfig?: PrivacyCaptureConfig): OTelMongoDBInstrumentation | null;
export interface MongoDBSpanAttributes {
    'db.system': 'mongodb';
    'db.name': string;
    'db.mongodb.cluster': string;
    'db.operation': string;
    'db.collection': string;
    'db.statement'?: string;
}
export { OTelMongoDBInstrumentation };
export default createMongoDBInstrumentation;
