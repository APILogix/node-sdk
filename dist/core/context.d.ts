import type { Breadcrumb, BreadcrumbInput } from '../types/breadcrumb.js';
import { RingBuffer } from './ring-buffer.js';
/**
 * Metadata carried on the OpenTelemetry context.
 *
 * Trace/span ownership belongs exclusively to OTel. The SDK stores request
 * metadata, breadcrumbs, user/session data, tags, and extra context here.
 */
export interface ContextStore {
    /** Unique request identifier. */
    readonly requestId: string;
    /** OpenTelemetry trace ID at context creation time. Prefer getTraceId(). */
    readonly traceId?: string | undefined;
    /** OpenTelemetry span ID at context creation time. Prefer getSpanId(). */
    readonly spanId?: string | undefined;
    /** User identifier for user-scoped telemetry. */
    readonly userId?: string | undefined;
    /** Session identifier. */
    readonly sessionId?: string | undefined;
    /** W3C Baggage entries propagated across service boundaries. */
    readonly baggage?: Readonly<Record<string, string>> | undefined;
    /** Breadcrumb ring buffer — bounded, auto-evicting. */
    readonly breadcrumbs: RingBuffer<Breadcrumb>;
    /** Custom tags for this request scope. */
    readonly tags?: Readonly<Record<string, string>> | undefined;
    /** Arbitrary extra context data. */
    readonly extra?: Readonly<Record<string, unknown>> | undefined;
}
export declare const LYNKTRACE_CONTEXT_ATTRIBUTES: {
    readonly requestId: 'lynktrace.request_id';
    readonly sessionId: 'lynktrace.session_id';
    readonly userId: 'lynktrace.user_id';
    readonly tenantId: 'lynktrace.tenant_id';
};
export declare const PULSE_CONTEXT_ATTRIBUTES: {
    readonly requestId: 'pulse.request_id';
    readonly sessionId: 'pulse.session_id';
    readonly userId: 'pulse.user_id';
    readonly tenantId: 'pulse.tenant_id';
};
/**
 * Get the current request context, or undefined if outside a context scope.
 */
export declare function getRequestContext(): ContextStore | undefined;
export declare function getRequestContextFromOtelContext(ctx?: import("@opentelemetry/api").Context): ContextStore | undefined;
/**
 * Get the current trace ID from context, or undefined.
 * Synchronizes traceId with ContextStore so correlation is preserved
 * even after child spans finish and pop off the active context stack.
 */
export declare function getTraceId(): string | undefined;
/**
 * Get the current span ID from context, or undefined.
 * Synchronizes spanId with ContextStore so correlation is preserved
 * even after child spans finish and pop off the active context stack.
 */
export declare function getSpanId(): string | undefined;
export declare function attachRequestContextToActiveSpan(store?: ContextStore | undefined): void;
/**
 * Add a breadcrumb to the current request context.
 * No-op if called outside a context scope.
 */
export declare function addBreadcrumb(input: BreadcrumbInput): void;
/**
 * Get all breadcrumbs from the current request context.
 * Returns an empty array if outside a context scope.
 */
export declare function getBreadcrumbs(): readonly Breadcrumb[];
/**
 * Create a new ContextStore with defaults.
 * Used by instrumentation middleware to establish per-request context.
 */
export declare function createContextStore(requestId: string, maxBreadcrumbs: number, overrides?: Partial<Omit<ContextStore, 'requestId' | 'breadcrumbs'>>): ContextStore;
/**
 * Run a function within an async context scope.
 * The context is automatically propagated through all async operations.
 */
export declare function withContext<T>(store: ContextStore, fn: () => T): T;
export declare function bindContext<T extends (...args: never[]) => unknown>(fn: T, store?: ContextStore | undefined): T;
