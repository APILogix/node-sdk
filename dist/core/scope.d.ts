/**
 * Scope management — global scope for user identification, tags, extra context.
 *
 * Provides Sentry-like APIs:
 * - setUser() — Identify the current user for all subsequent events
 * - setTag() — Set a single tag key/value pair
 * - setTags() — Set multiple tags at once
 * - setExtra() — Set a single extra context key/value
 * - setExtras() — Set multiple extra context entries at once
 * - setContext() — Set a named context object (structured data)
 * - getContext() — Get all current context data
 * - clear() — Reset all scope data
 * - withScope() — Run a function with an isolated scope clone
 *
 * Scope data is automatically attached to all events captured in the
 * current async context. If AsyncLocalStorage is active, scope is
 * request-scoped; otherwise it falls back to global scope.
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
declare class ScopeManager {
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
export declare const scopeManager: ScopeManager;
/**
 * Set the current user for all subsequent events.
 * @example
 * ```ts
 * setUser({ id: 'user_123', email: 'user@example.com', username: 'john' })
 * ```
 */
export declare function setUser(user: User | null): void;
/**
 * Set a single tag key/value pair.
 * @example
 * ```ts
 * setTag('environment', 'production')
 * ```
 */
export declare function setTag(key: string, value: string): void;
/**
 * Set multiple tags at once.
 */
export declare function setTags(tags: Record<string, string>): void;
/**
 * Remove a tag by key.
 */
export declare function removeTag(key: string): void;
/**
 * Set a single extra context key/value.
 */
export declare function setExtra(key: string, value: unknown): void;
/**
 * Set multiple extra context entries at once.
 */
export declare function setExtras(extras: Record<string, unknown>): void;
/**
 * Remove an extra context entry by key.
 */
export declare function removeExtra(key: string): void;
/**
 * Set a named context object.
 * @example
 * ```ts
 * setContext('device', { model: 'iPhone 15', os: 'iOS 17' })
 * ```
 */
export declare function setContext(name: string, context: Record<string, unknown> | null): void;
/**
 * Get scope data snapshot.
 */
export declare function getScopeData(): ScopeData;
/**
 * Clear all scope data.
 */
export declare function clearScope(): void;
/**
 * Run a function with an isolated scope clone.
 * Changes made inside the callback do not affect the parent scope.
 * @example
 * ```ts
 * withScope((scope) => {
 *   scope.setTag('operation', 'payment')
 *   captureError(error) // includes the operation tag
 * })
 * ```
 */
export declare function withScope<T>(fn: (scope: ScopeManager) => T): T;
/**
 * Apply scope data to an event. Merges user, tags, extra, and contexts
 * from the global scope (or async context if available) into the event.
 */
export declare function applyScopeToEvent(event: Record<string, unknown>): Record<string, unknown>;
export {};
//# sourceMappingURL=scope.d.ts.map