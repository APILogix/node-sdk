/**
 * Worker Context Serialization — context propagation for worker threads.
 *
 * OTel context/lifecycle MUST remain on the main thread.
 * Worker threads receive serialized context for correlation only —
 * they do NOT create/manage OTel providers or exporters.
 *
 * This module:
 * - Serializes OTel span context + SDK request context → transferable data
 * - Deserializes on worker side for correlation metadata
 * - Provides worker data helpers for worker_threads postMessage
 */
export interface SerializedContext {
    readonly traceId: string;
    readonly spanId: string;
    readonly traceFlags: number;
    readonly traceState?: string | undefined;
    readonly requestId?: string | undefined;
    readonly sessionId?: string | undefined;
    readonly tenantId?: string | undefined;
}
/**
 * Serialize the current OTel span context + SDK request context
 * into a plain object for passing to worker threads.
 *
 * Returns null if no active span context exists.
 */
export declare function serializeContext(): SerializedContext | null;
/**
 * Create workerData for worker_threads.Worker constructor.
 * Includes serialized context + any additional data.
 */
export declare function createWorkerData(additionalData?: Record<string, unknown>): Record<string, unknown>;
/**
 * Extract serialized context from workerData on the worker side.
 * Call this inside the worker thread to get correlation metadata.
 */
export declare function extractWorkerContext(workerData: Record<string, unknown>): SerializedContext | null;
