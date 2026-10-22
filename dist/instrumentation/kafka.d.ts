/**
 * Apache Kafka Instrumentation — auto-instrumentation for kafkajs.
 *
 * Implements:
 * - Producer send interception with W3C tracecontext header injection
 * - Consumer batch/message interception with trace context propagation
 * - Configurable batch-level vs message-level span granularity
 * - Message key & partition metadata capture
 */
import type { PrivacyCaptureConfig } from '../types/config.js';
export interface KafkaInstrumentationOptions {
    enabled: boolean;
    emitConsumerBatchSpans?: boolean;
    captureMessageKey?: boolean;
}
export declare function createKafkaInstrumentation(enabled: boolean, options?: Partial<KafkaInstrumentationOptions>, _captureConfig?: PrivacyCaptureConfig): {
    enable: () => void;
    disable: () => void;
    teardown: () => void;
} | null;
