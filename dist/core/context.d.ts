import { AsyncLocalStorage } from 'async_hooks';
import type { Breadcrumb, BreadcrumbInput } from '../types/breadcrumb.js';
import { RingBuffer } from './ring-buffer.js';
/**
 * The async context store — propagated through promises, timers, callbacks.
 * Every request gets its own isolated store via AsyncLocalStorage.run().
 */
export interface ContextStore {
    /** Unique request identifier. */
    readonly requestId: string;
    /** OpenTelemetry trace ID (if tracing enabled). */
    readonly traceId?: string | undefined;
    /** OpenTelemetry span ID (if tracing enabled). */
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
export declare const asyncLocalStorage: AsyncLocalStorage<ContextStore>;
/**
 * Get the current request context, or undefined if outside a context scope.
 */
export declare function getRequestContext(): ContextStore | undefined;
/**
 * Get the current trace ID from context, or undefined.
 */
export declare function getTraceId(): string | undefined;
/**
 * Get the current span ID from context, or undefined.
 */
export declare function getSpanId(): string | undefined;
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
//# sourceMappingURL=context.d.ts.map