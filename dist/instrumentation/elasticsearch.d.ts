/**
 * Elasticsearch & OpenSearch Instrumentation — auto-instrumentation for
 * official @elastic/elasticsearch and @opensearch-project/opensearch clients.
 *
 * Captures:
 * - Search operations with hit counts and cluster execution duration (took)
 * - Indexing, bulk operations, and document updates
 * - Target index name and HTTP status
 * - Sanitized Query DSL payloads
 */
import type { PrivacyCaptureConfig } from '../types/config.js';
export interface ElasticsearchInstrumentationOptions {
    enabled: boolean;
    captureQueries?: boolean;
}
export declare function createElasticsearchInstrumentation(enabled: boolean, options?: Partial<ElasticsearchInstrumentationOptions>, captureConfig?: PrivacyCaptureConfig): {
    enable: () => void;
    disable: () => void;
    teardown: () => void;
} | null;
