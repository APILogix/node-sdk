/**
 * RabbitMQ / AMQP Instrumentation — auto-instrumentation for amqplib.
 *
 * Implements:
 * - Channel.publish & Channel.sendToQueue context injection
 * - Channel.consume context extraction
 * - Memory-safe binary buffer handling (zero stringification of raw payloads)
 */
import type { PrivacyCaptureConfig } from '../types/config.js';
export interface AMQPInstrumentationOptions {
    enabled: boolean;
    captureMessageData?: boolean;
}
export declare function createAMQPInstrumentation(enabled: boolean, _options?: Partial<AMQPInstrumentationOptions>, _captureConfig?: PrivacyCaptureConfig): {
    enable: () => void;
    disable: () => void;
    teardown: () => void;
} | null;
