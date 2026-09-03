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
export interface User {
    /** Unique user identifier (email, UUID, database ID, etc.). */
    id?: string | undefined;
    /** User email address. */
    email?: string | undefined;
    /** Username or display name. */
    username?: string | undefined;
    /** User IP address. */
    ipAddress?: string | undefined;
    /** Additional user attributes. */
    data?: Record<string, unknown> | undefined;
}
export interface ScopeData {
    user: User | null;
    tags: Record<string, string>;
    extra: Record<string, unknown>;
    contexts: Record<string, Record<string, unknown>>;
}
export declare class ScopeManager {
    private user;
    private tags;
    private extra;
    private contexts;
    /**
     * Set the current user. This user will be attached to all subsequent events.
     * Pass null to clear the user.
     */
    setUser(user: User | null): void;
    /**
     * Get the current user.
     */
    getUser(): User | null;
    /**
     * Set a single tag key/value pair. Tags are string-only and used for filtering.
     */
    setTag(key: string, value: string): void;
    /**
     * Set multiple tags at once.
     */
    setTags(tags: Record<string, string>): void;
    /**
     * Remove a tag by key.
     */
    removeTag(key: string): void;
    /**
     * Get all current tags.
     */
    getTags(): Readonly<Record<string, string>>;
    /**
     * Set a single extra context key/value. Extra can hold arbitrary data.
     */
    setExtra(key: string, value: unknown): void;
    /**
     * Set multiple extra context entries at once.
     */
    setExtras(extras: Record<string, unknown>): void;
    /**
     * Remove an extra context entry by key.
     */
    removeExtra(key: string): void;
    /**
     * Get all current extra context.
     */
    getExtras(): Readonly<Record<string, unknown>>;
    /**
     * Set a named context object. Contexts are structured data sections
     * (e.g., 'device', 'os', 'app', 'culture').
     */
    setContext(name: string, context: Record<string, unknown> | null): void;
    /**
     * Get a named context, or all contexts if no name provided.
     */
    getContext(name?: string): Record<string, unknown> | Readonly<Record<string, Record<string, unknown>>> | null;
    /**
     * Get a complete snapshot of all scope data.
     */
    getScopeData(): ScopeData;
    /**
     * Clone this scope into a new ScopeManager instance.
     */
    clone(): ScopeManager;
    /**
     * Reset all scope data to initial state.
     */
    clear(): void;
}
/**
 * Module-level global scope. Used as the fallback when no request-local
 * scope exists on the OTel context (i.e., outside any `withScope()` block
 * or request middleware).
 */
export declare const scopeManager: ScopeManager;
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
export declare function setUser(user: User | null): void;
/**
 * Set a single tag key/value pair in the active scope.
 * @example
 * ```ts
 * setTag('environment', 'production')
 * ```
 */
export declare function setTag(key: string, value: string): void;
/**
 * Set multiple tags at once in the active scope.
 */
export declare function setTags(tags: Record<string, string>): void;
/**
 * Remove a tag by key from the active scope.
 */
export declare function removeTag(key: string): void;
/**
 * Set a single extra context key/value in the active scope.
 */
export declare function setExtra(key: string, value: unknown): void;
/**
 * Set multiple extra context entries at once in the active scope.
 */
export declare function setExtras(extras: Record<string, unknown>): void;
/**
 * Remove an extra context entry by key from the active scope.
 */
export declare function removeExtra(key: string): void;
/**
 * Set a named context object in the active scope.
 * @example
 * ```ts
 * setContext('device', { model: 'iPhone 15', os: 'iOS 17' })
 * ```
 */
export declare function setContext(name: string, context: Record<string, unknown> | null): void;
/**
 * Get scope data snapshot from the active scope.
 */
export declare function getScopeData(): ScopeData;
/**
 * Clear all scope data in the active scope.
 */
export declare function clearScope(): void;
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
export declare function withScope<T>(fn: (scope: ScopeManager) => T): T;
/**
 * Apply scope data to an event. Merges user, tags, extra, and contexts
 * from the active scope (request-local or global) + request context.
 *
 * Merge precedence (highest wins):
 *   1. Request context (ContextStore — per-request metadata)
 *   2. Active scope (withScope clone or global fallback)
 *   3. Event's own values (never overwritten)
 */
export declare function applyScopeToEvent(event: Record<string, unknown>): Record<string, unknown>;
