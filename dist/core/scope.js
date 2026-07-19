/**
 * Scope management — request-scoped metadata via OTel context + ALS propagation.
 *
 * Architecture:
 *   Scope data (user, tags, extra, contexts) is stored on the OpenTelemetry
 *   context using `createContextKey()`. This ensures scope is automatically
 *   propagated through AsyncLocalStorage across:
 *     - Promises / async-await
 *     - Timers (setTimeout, setInterval)
 *     - HTTP/fetch requests
 *     - Express middleware chains
 *     - Fastify hooks
 *     - Worker thread boundaries (via serialized context)
 *
 * Layered resolution:
 *   1. Request-local scope (set via `withScope()` on OTel context)
 *   2. Global scope fallback (module-level singleton)
 *
 * OTel alignment:
 *   OTel owns tracing context (spans, trace IDs). The SDK scope is a
 *   SEPARATE concern — it carries user metadata, tags, and extra context
 *   that enrich all events captured within the scope.
 *
 * Public API (Sentry-compatible):
 *   - setUser() — identify the current user
 *   - setTag() / setTags() — set filtering tags
 *   - setExtra() / setExtras() — set arbitrary context
 *   - setContext() — set named structured context
 *   - getScopeData() — snapshot all scope data
 *   - clearScope() — reset scope to initial state
 *   - withScope(fn) — run fn with an isolated, ALS-propagated scope clone
 */
import { context as otelContext, createContextKey } from '@opentelemetry/api';
import { getRequestContext } from './context.js';
import { RingBuffer } from './ring-buffer.js';
import { getLogger } from '../utils/logger.js';
// ─── OTel Context Key ───────────────────────────────────────────────────────
/**
 * Context key for scope storage on the OTel context.
 * This enables ALS propagation of scope through all async operations.
 */
const SCOPE_KEY = createContextKey('pulse-sdk-scope');
// ─── Scope Manager ──────────────────────────────────────────────────────────
export class ScopeManager {
    user = null;
    tags = {};
    extra = {};
    contexts = {};
    // ─── User Identification ──────────────────────────────────────────────
    /**
     * Set the current user. This user will be attached to all subsequent events.
     * Pass null to clear the user.
     */
    setUser(user) {
        this.user = user ? { ...user } : null;
    }
    /**
     * Get the current user.
     */
    getUser() {
        return this.user ? { ...this.user } : null;
    }
    // ─── Tags ─────────────────────────────────────────────────────────────
    /**
     * Set a single tag key/value pair. Tags are string-only and used for filtering.
     */
    setTag(key, value) {
        this.tags[key] = value;
    }
    /**
     * Set multiple tags at once.
     */
    setTags(tags) {
        for (const [key, value] of Object.entries(tags)) {
            this.tags[key] = value;
        }
    }
    /**
     * Remove a tag by key.
     */
    removeTag(key) {
        delete this.tags[key];
    }
    /**
     * Get all current tags.
     */
    getTags() {
        return { ...this.tags };
    }
    // ─── Extra Context ────────────────────────────────────────────────────
    /**
     * Set a single extra context key/value. Extra can hold arbitrary data.
     */
    setExtra(key, value) {
        this.extra[key] = value;
    }
    /**
     * Set multiple extra context entries at once.
     */
    setExtras(extras) {
        for (const [key, value] of Object.entries(extras)) {
            this.extra[key] = value;
        }
    }
    /**
     * Remove an extra context entry by key.
     */
    removeExtra(key) {
        delete this.extra[key];
    }
    /**
     * Get all current extra context.
     */
    getExtras() {
        return { ...this.extra };
    }
    // ─── Named Contexts ───────────────────────────────────────────────────
    /**
     * Set a named context object. Contexts are structured data sections
     * (e.g., 'device', 'os', 'app', 'culture').
     */
    setContext(name, context) {
        if (context === null) {
            delete this.contexts[name];
        }
        else {
            this.contexts[name] = { ...context };
        }
    }
    /**
     * Get a named context, or all contexts if no name provided.
     */
    getContext(name) {
        if (name) {
            const ctx = this.contexts[name];
            return ctx ? { ...ctx } : null;
        }
        return { ...this.contexts };
    }
    // ─── Scope Snapshot ───────────────────────────────────────────────────
    /**
     * Get a complete snapshot of all scope data.
     */
    getScopeData() {
        return {
            user: this.user ? { ...this.user } : null,
            tags: { ...this.tags },
            extra: { ...this.extra },
            contexts: { ...this.contexts },
        };
    }
    // ─── Clone / Isolation ────────────────────────────────────────────────
    /**
     * Clone this scope into a new ScopeManager instance.
     */
    clone() {
        const cloned = new ScopeManager();
        cloned.user = this.user ? { ...this.user } : null;
        cloned.tags = { ...this.tags };
        cloned.extra = { ...this.extra };
        cloned.contexts = {};
        for (const [name, ctx] of Object.entries(this.contexts)) {
            cloned.contexts[name] = { ...ctx };
        }
        return cloned;
    }
    // ─── Clear ────────────────────────────────────────────────────────────
    /**
     * Reset all scope data to initial state.
     */
    clear() {
        this.user = null;
        this.tags = {};
        this.extra = {};
        this.contexts = {};
    }
}
// ─── Global Scope Fallback ──────────────────────────────────────────────────
/**
 * Module-level global scope. Used as the fallback when no request-local
 * scope exists on the OTel context (i.e., outside any `withScope()` block
 * or request middleware).
 */
export const scopeManager = new ScopeManager();
// ─── Active Scope Resolution ────────────────────────────────────────────────
/**
 * Resolve the currently active scope.
 *
 * Resolution order:
 *   1. Request-local scope on the OTel context (set via `withScope()`)
 *   2. Global scope fallback (module-level singleton)
 *
 * This function is the single point of scope resolution for all public APIs.
 * It ensures that `setTag()`, `setUser()`, etc. mutate the correct scope
 * depending on whether they're called inside a `withScope()` block.
 */
function getActiveScope() {
    const ctxScope = otelContext.active().getValue(SCOPE_KEY);
    return ctxScope ?? scopeManager;
}
// ─── Public API ─────────────────────────────────────────────────────────────
/**
 * Set the current user for all subsequent events in the active scope.
 *
 * When called inside `withScope()`, only affects the isolated scope.
 * When called outside, affects the global scope.
 *
 * @example
 * ```ts
 * setUser({ id: 'user_123', email: 'user@example.com', username: 'john' })
 * ```
 */
export function setUser(user) {
    getActiveScope().setUser(user);
}
/**
 * Set a single tag key/value pair in the active scope.
 * @example
 * ```ts
 * setTag('environment', 'production')
 * ```
 */
export function setTag(key, value) {
    getActiveScope().setTag(key, value);
}
/**
 * Set multiple tags at once in the active scope.
 */
export function setTags(tags) {
    getActiveScope().setTags(tags);
}
/**
 * Remove a tag by key from the active scope.
 */
export function removeTag(key) {
    getActiveScope().removeTag(key);
}
/**
 * Set a single extra context key/value in the active scope.
 */
export function setExtra(key, value) {
    getActiveScope().setExtra(key, value);
}
/**
 * Set multiple extra context entries at once in the active scope.
 */
export function setExtras(extras) {
    getActiveScope().setExtras(extras);
}
/**
 * Remove an extra context entry by key from the active scope.
 */
export function removeExtra(key) {
    getActiveScope().removeExtra(key);
}
/**
 * Set a named context object in the active scope.
 * @example
 * ```ts
 * setContext('device', { model: 'iPhone 15', os: 'iOS 17' })
 * ```
 */
export function setContext(name, context) {
    getActiveScope().setContext(name, context);
}
/**
 * Get scope data snapshot from the active scope.
 */
export function getScopeData() {
    return getActiveScope().getScopeData();
}
/**
 * Clear all scope data in the active scope.
 */
export function clearScope() {
    getActiveScope().clear();
}
/**
 * Run a function with an isolated scope clone, propagated through AsyncLocalStorage.
 *
 * The cloned scope is set on the OTel context, which means:
 *   - All async operations inside `fn` see the cloned scope
 *   - `setTag()`, `setUser()`, etc. inside `fn` mutate the clone, not the parent
 *   - `captureError()`, `captureRequest()`, etc. inside `fn` are enriched from the clone
 *   - The parent scope is NOT affected by mutations inside `fn`
 *
 * This works correctly across:
 *   - Promises / async-await
 *   - setTimeout / setInterval
 *   - HTTP requests (fetch/undici)
 *   - Express middleware chains
 *   - Fastify hooks
 *
 * @example
 * ```ts
 * withScope((scope) => {
 *   scope.setTag('operation', 'payment')
 *   captureError(error) // includes the 'operation' tag
 * })
 * // 'operation' tag is NOT visible here
 * ```
 */
export function withScope(fn) {
    const cloned = getActiveScope().clone();
    const ctx = otelContext.active().setValue(SCOPE_KEY, cloned);
    return otelContext.with(ctx, () => fn(cloned));
}
/**
 * Apply scope data to an event. Merges user, tags, extra, and contexts
 * from the active scope (request-local or global) + request context.
 *
 * Merge precedence (highest wins):
 *   1. Request context (ContextStore — per-request metadata)
 *   2. Active scope (withScope clone or global fallback)
 *   3. Event's own values (never overwritten)
 */
export function applyScopeToEvent(event) {
    const ctx = getRequestContext();
    const scope = getActiveScope();
    const enriched = { ...event };
    // User: context userId takes precedence, then active scope user
    if (ctx?.userId && !enriched['user']) {
        enriched['user'] = { id: ctx.userId };
    }
    else if (scope.getUser() && !enriched['user']) {
        enriched['user'] = scope.getUser();
    }
    // Tags: merge active scope tags with context tags (context wins)
    const mergedTags = { ...scope.getTags() };
    if (ctx?.tags) {
        for (const [key, value] of Object.entries(ctx.tags)) {
            mergedTags[key] = value;
        }
    }
    if (Object.keys(mergedTags).length > 0) {
        enriched['tags'] = mergedTags;
    }
    // Extra: merge active scope extra with context extra (context wins)
    const mergedExtra = { ...scope.getExtras() };
    if (ctx?.extra) {
        for (const [key, value] of Object.entries(ctx.extra)) {
            mergedExtra[key] = value;
        }
    }
    if (Object.keys(mergedExtra).length > 0) {
        enriched['extra'] = mergedExtra;
    }
    // Contexts: from active scope
    const contexts = scope.getContext();
    if (contexts && Object.keys(contexts).length > 0) {
        enriched['contexts'] = contexts;
    }
    return enriched;
}
//# sourceMappingURL=scope.js.map