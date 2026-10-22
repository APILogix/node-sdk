/**
 * gRPC Instrumentation — auto-instrumentation for @grpc/grpc-js.
 *
 * Implements:
 * - Client RPC call interception (Unary, Client Streaming, Server Streaming, Bidi)
 * - W3C traceparent injection into gRPC Metadata
 * - Status code & error translation
 */
export declare function createGrpcInstrumentation(enabled: boolean): {
    enable: () => void;
    disable: () => void;
    teardown: () => void;
} | null;
