import { AsyncLocalStorage } from 'async_hooks';
import { Severity } from '../types/severity.js';
import { isoNow } from '../utils/time.js';
import { RingBuffer } from './ring-buffer.js';
import { client } from './client.js';
import { getLogger } from '../utils/logger.js';
// ─── AsyncLocalStorage Instance ─────────────────────────────────────────────
export const asyncLocalStorage = new AsyncLocalStorage();
// ─── Context Accessors ──────────────────────────────────────────────────────
/**
 * Get the current request context, or undefined if outside a context scope.
 */
export function getRequestContext() {
    return asyncLocalStorage.getStore();
}
/**
 * Get the current trace ID from context, or undefined.
 */
export function getTraceId() {
    return asyncLocalStorage.getStore()?.traceId;
}
/**
 * Get the current span ID from context, or undefined.
 */
export function getSpanId() {
    return asyncLocalStorage.getStore()?.spanId;
}
// ─── Context Mutation (within scope) ────────────────────────────────────────
/**
 * Add a breadcrumb to the current request context.
 * No-op if called outside a context scope.
 */
export function addBreadcrumb(input) {
    const store = asyncLocalStorage.getStore();
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
    const store = asyncLocalStorage.getStore();
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
    return {
        requestId,
        traceId: overrides?.traceId,
        spanId: overrides?.spanId,
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
    return asyncLocalStorage.run(store, fn);
}
//# sourceMappingURL=context.js.map