/**
 * AWS SQS & SNS Instrumentation — auto-instrumentation for @aws-sdk/client-sqs
 * and @aws-sdk/client-sns.
 *
 * Implements:
 * - W3C tracecontext propagation via SQS/SNS MessageAttributes
 * - SendMessage, SendMessageBatch, ReceiveMessage, and Publish tracking
 */
export declare function createSqsSnsInstrumentation(sqsEnabled: boolean, snsEnabled: boolean): {
    enable: () => void;
    disable: () => void;
    teardown: () => void;
} | null;
