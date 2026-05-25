import { AsyncLocalStorage } from 'async_hooks';
import { context as otelContext, createContextKey, trace } from '@opentelemetry/api';
import { Severity } from '../types/severity.js';
import { isoNow } from '../utils/time.js';
import { RingBuffer } from './ring-buffer.js';
import { client } from './client.js';
import { getLogger } from '../utils/logger.js';
const CONTEXT_STORE_KEY = createContextKey('pulse-sdk-context-store');
const contextStorage = new AsyncLocalStorage();
export const PULSE_CONTEXT_ATTRIBUTES = {
    requestId: 'pulse.request_id',
    sessionId: 'pulse.session_id',
    userId: 'pulse.user_id',
    tenantId: 'pulse.tenant_id',
};
// ─── Context Accessors ──────────────────────────────────────────────────────
/**
 * Get the current request context, or undefined if outside a context scope.
 */
export function getRequestContext() {
    return contextStorage.getStore()
        ?? otelContext.active().getValue(CONTEXT_STORE_KEY);
}
export function getRequestContextFromOtelContext(ctx = otelContext.active()) {
    return ctx.getValue(CONTEXT_STORE_KEY);
}
/**
 * Get the current trace ID from context, or undefined.
 */
export function getTraceId() {
    return trace.getActiveSpan()?.spanContext().traceId ?? getRequestContext()?.traceId;
}
/**
 * Get the current span ID from context, or undefined.
 */
export function getSpanId() {
    return trace.getActiveSpan()?.spanContext().spanId ?? getRequestContext()?.spanId;
}
export function attachRequestContextToActiveSpan(store = getRequestContext()) {
    if (!store)
        return;
    const activeSpan = trace.getActiveSpan();
    if (!activeSpan)
        return;
    const tenantId = store.extra?.['tenantId'];
    const attributes = {
        [PULSE_CONTEXT_ATTRIBUTES.requestId]: store.requestId,
    };
    if (store.sessionId)
        attributes[PULSE_CONTEXT_ATTRIBUTES.sessionId] = store.sessionId;
    if (store.userId)
        attributes[PULSE_CONTEXT_ATTRIBUTES.userId] = store.userId;
    if (typeof tenantId === 'string' && tenantId)
        attributes[PULSE_CONTEXT_ATTRIBUTES.tenantId] = tenantId;
    try {
        activeSpan.setAttributes(attributes);
    }
    catch {
        // Span mutation must never affect application control flow.
    }
}
// ─── Context Mutation (within scope) ────────────────────────────────────────
/**
 * Add a breadcrumb to the current request context.
 * No-op if called outside a context scope.
 */
export function addBreadcrumb(input) {
    const store = getRequestContext();
    if (!store)
        return;
    let breadcrumb = {
        timestamp: isoNow(),
        category: input.category,
        message: input.message,
        level: input.level ?? Severity.Info,
        type: input.type ?? 'default',
        data: input.data,
    };
    const logger = getLogger();
    const hint = input.data === undefined
        ? { originalEvent: input }
        : { originalEvent: input, data: input.data };
    if (client.options?.beforeBreadcrumb) {
        try {
            const result = client.options.beforeBreadcrumb(breadcrumb, hint);
            if (result === null)
                return;
            breadcrumb = result;
        }
        catch (error) {
            logger.warn('beforeBreadcrumb threw', { error });
        }
    }
    if (client.initialized) {
        for (const plugin of client.plugins) {
            if (!plugin.processBreadcrumb)
                continue;
            try {
                const result = plugin.processBreadcrumb(breadcrumb, hint);
                if (result === null)
                    return;
                breadcrumb = result;
            }
            catch (error) {
                logger.warn('Plugin processBreadcrumb threw', {
                    pluginName: plugin.meta.name,
                    error,
                });
            }
        }
    }
    store.breadcrumbs.push(breadcrumb);
}
/**
 * Get all breadcrumbs from the current request context.
 * Returns an empty array if outside a context scope.
 */
export function getBreadcrumbs() {
    const store = getRequestContext();
    if (!store)
        return [];
    return store.breadcrumbs.toArray();
}
// ─── Context Factory ────────────────────────────────────────────────────────
/**
 * Create a new ContextStore with defaults.
 * Used by instrumentation middleware to establish per-request context.
 */
export function createContextStore(requestId, maxBreadcrumbs, overrides) {
    const activeSpanContext = trace.getActiveSpan()?.spanContext();
    return {
        requestId,
        traceId: activeSpanContext?.traceId ?? overrides?.traceId,
        spanId: activeSpanContext?.spanId ?? overrides?.spanId,
        userId: overrides?.userId,
        sessionId: overrides?.sessionId,
        baggage: overrides?.baggage,
        breadcrumbs: new RingBuffer(maxBreadcrumbs),
        tags: overrides?.tags,
        extra: overrides?.extra,
    };
}
/**
 * Run a function within an async context scope.
 * The context is automatically propagated through all async operations.
 */
export function withContext(store, fn) {
    const ctx = otelContext.active().setValue(CONTEXT_STORE_KEY, store);
    return contextStorage.run(store, () => otelContext.with(ctx, () => {
        attachRequestContextToActiveSpan(store);
        return fn();
    }));
}
export function bindContext(fn, store = getRequestContext()) {
    if (!store)
        return fn;
    return function boundContext(...args) {
        return withContext(store, () => fn.apply(this, args));
    };
}
//# sourceMappingURL=context.js.map