/**
 * AWS DynamoDB Instrumentation — auto-instrumentation for AWS SDK v3 DynamoDB
 * clients (@aws-sdk/client-dynamodb and @aws-sdk/lib-dynamodb).
 *
 * Captures:
 * - Low-level commands (GetItem, PutItem, Query, Scan, BatchWriteItem)
 * - High-level DocumentClient commands
 * - Consumed capacity units (RCU / WCU)
 * - Sanitized primary key & projection attributes
 * - Regional latency & request tracking
 */
import type { PrivacyCaptureConfig } from '../types/config.js';
export interface DynamoDBInstrumentationOptions {
    enabled: boolean;
    captureQueries?: boolean;
    captureParams?: boolean;
}
/**
 * Patches DynamoDBClient and DynamoDBDocumentClient prototypes.
 */
export declare function createDynamoDBInstrumentation(enabled: boolean, options?: Partial<DynamoDBInstrumentationOptions>, captureConfig?: PrivacyCaptureConfig): {
    enable: () => void;
    disable: () => void;
    teardown: () => void;
} | null;
