/**
 * Google Cloud Pub/Sub Instrumentation — auto-instrumentation for @google-cloud/pubsub.
 */
export declare function createPubSubInstrumentation(enabled: boolean): {
    enable: () => void;
    disable: () => void;
    teardown: () => void;
} | null;
