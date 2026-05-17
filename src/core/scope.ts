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

import { asyncLocalStorage, getRequestContext, createContextStore, withContext } from './context.js'
import { RingBuffer } from './ring-buffer.js'
import type { Breadcrumb } from '../types/breadcrumb.js'
import { getLogger } from '../utils/logger.js'

// ─── User Interface ─────────────────────────────────────────────────────────

export interface User {
  /** Unique user identifier (email, UUID, database ID, etc.). */
  id?: string | undefined
  /** User email address. */
  email?: string | undefined
  /** Username or display name. */
  username?: string | undefined
  /** User IP address. */
  ipAddress?: string | undefined
  /** Additional user attributes. */
  data?: Record<string, unknown> | undefined
}

// ─── Scope Data ─────────────────────────────────────────────────────────────

export interface ScopeData {
  user: User | null
  tags: Record<string, string>
  extra: Record<string, unknown>
  contexts: Record<string, Record<string, unknown>>
}

// ─── Global Scope ───────────────────────────────────────────────────────────

class ScopeManager {
  private user: User | null = null
  private tags: Record<string, string> = {}
  private extra: Record<string, unknown> = {}
  private contexts: Record<string, Record<string, unknown>> = {}

  // ─── User Identification ──────────────────────────────────────────────

  /**
   * Set the current user. This user will be attached to all subsequent events.
   * Pass null to clear the user.
   */
  setUser(user: User | null): void {
    this.user = user ? { ...user } : null
  }

  /**
   * Get the current user.
   */
  getUser(): User | null {
    return this.user ? { ...this.user } : null
  }

  // ─── Tags ─────────────────────────────────────────────────────────────

  /**
   * Set a single tag key/value pair. Tags are string-only and used for filtering.
   */
  setTag(key: string, value: string): void {
    this.tags[key] = value
  }

  /**
   * Set multiple tags at once.
   */
  setTags(tags: Record<string, string>): void {
    for (const [key, value] of Object.entries(tags)) {
      this.tags[key] = value
    }
  }

  /**
   * Remove a tag by key.
   */
  removeTag(key: string): void {
    delete this.tags[key]
  }

  /**
   * Get all current tags.
   */
  getTags(): Readonly<Record<string, string>> {
    return { ...this.tags }
  }

  // ─── Extra Context ────────────────────────────────────────────────────

  /**
   * Set a single extra context key/value. Extra can hold arbitrary data.
   */
  setExtra(key: string, value: unknown): void {
    this.extra[key] = value
  }

  /**
   * Set multiple extra context entries at once.
   */
  setExtras(extras: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(extras)) {
      this.extra[key] = value
    }
  }

  /**
   * Remove an extra context entry by key.
   */
  removeExtra(key: string): void {
    delete this.extra[key]
  }

  /**
   * Get all current extra context.
   */
  getExtras(): Readonly<Record<string, unknown>> {
    return { ...this.extra }
  }

  // ─── Named Contexts ───────────────────────────────────────────────────

  /**
   * Set a named context object. Contexts are structured data sections
   * (e.g., 'device', 'os', 'app', 'culture').
   */
  setContext(name: string, context: Record<string, unknown> | null): void {
    if (context === null) {
      delete this.contexts[name]
    } else {
      this.contexts[name] = { ...context }
    }
  }

  /**
   * Get a named context, or all contexts if no name provided.
   */
  getContext(name?: string): Record<string, unknown> | Readonly<Record<string, Record<string, unknown>>> | null {
    if (name) {
      const ctx = this.contexts[name]
      return ctx ? { ...ctx } : null
    }
    return { ...this.contexts }
  }

  // ─── Scope Snapshot ───────────────────────────────────────────────────

  /**
   * Get a complete snapshot of all scope data.
   */
  getScopeData(): ScopeData {
    return {
      user: this.user ? { ...this.user } : null,
      tags: { ...this.tags },
      extra: { ...this.extra },
      contexts: { ...this.contexts },
    }
  }

  // ─── Clone / Isolation ────────────────────────────────────────────────

  /**
   * Clone this scope into a new ScopeManager instance.
   */
  clone(): ScopeManager {
    const cloned = new ScopeManager()
    cloned.user = this.user ? { ...this.user } : null
    cloned.tags = { ...this.tags }
    cloned.extra = { ...this.extra }
    cloned.contexts = {}
    for (const [name, ctx] of Object.entries(this.contexts)) {
      cloned.contexts[name] = { ...ctx }
    }
    return cloned
  }

  // ─── Clear ────────────────────────────────────────────────────────────

  /**
   * Reset all scope data to initial state.
   */
  clear(): void {
    this.user = null
    this.tags = {}
    this.extra = {}
    this.contexts = {}
  }
}

// ─── Singleton ──────────────────────────────────────────────────────────────

export const scopeManager = new ScopeManager()

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Set the current user for all subsequent events.
 * @example
 * ```ts
 * setUser({ id: 'user_123', email: 'user@example.com', username: 'john' })
 * ```
 */
export function setUser(user: User | null): void {
  scopeManager.setUser(user)
}

/**
 * Set a single tag key/value pair.
 * @example
 * ```ts
 * setTag('environment', 'production')
 * ```
 */
export function setTag(key: string, value: string): void {
  scopeManager.setTag(key, value)
}

/**
 * Set multiple tags at once.
 */
export function setTags(tags: Record<string, string>): void {
  scopeManager.setTags(tags)
}

/**
 * Remove a tag by key.
 */
export function removeTag(key: string): void {
  scopeManager.removeTag(key)
}

/**
 * Set a single extra context key/value.
 */
export function setExtra(key: string, value: unknown): void {
  scopeManager.setExtra(key, value)
}

/**
 * Set multiple extra context entries at once.
 */
export function setExtras(extras: Record<string, unknown>): void {
  scopeManager.setExtras(extras)
}

/**
 * Remove an extra context entry by key.
 */
export function removeExtra(key: string): void {
  scopeManager.removeExtra(key)
}

/**
 * Set a named context object.
 * @example
 * ```ts
 * setContext('device', { model: 'iPhone 15', os: 'iOS 17' })
 * ```
 */
export function setContext(name: string, context: Record<string, unknown> | null): void {
  scopeManager.setContext(name, context)
}

/**
 * Get scope data snapshot.
 */
export function getScopeData(): ScopeData {
  return scopeManager.getScopeData()
}

/**
 * Clear all scope data.
 */
export function clearScope(): void {
  scopeManager.clear()
}

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
export function withScope<T>(fn: (scope: ScopeManager) => T): T {
  const cloned = scopeManager.clone()
  return fn(cloned)
}

/**
 * Apply scope data to an event. Merges user, tags, extra, and contexts
 * from the global scope (or async context if available) into the event.
 */
export function applyScopeToEvent(event: Record<string, unknown>): Record<string, unknown> {
  const ctx = getRequestContext()
  const scope = scopeManager

  const enriched: Record<string, unknown> = { ...event }

  // User: context userId takes precedence, then global scope user
  if (ctx?.userId && !enriched['user']) {
    enriched['user'] = { id: ctx.userId }
  } else if (scope.getUser() && !enriched['user']) {
    enriched['user'] = scope.getUser()
  }

  // Tags: merge context tags with global scope tags
  const mergedTags: Record<string, string> = { ...scope.getTags() }
  if (ctx?.tags) {
    for (const [key, value] of Object.entries(ctx.tags)) {
      mergedTags[key] = value
    }
  }
  if (Object.keys(mergedTags).length > 0) {
    enriched['tags'] = mergedTags
  }

  // Extra: merge context extra with global scope extra
  const mergedExtra: Record<string, unknown> = { ...scope.getExtras() }
  if (ctx?.extra) {
    for (const [key, value] of Object.entries(ctx.extra)) {
      mergedExtra[key] = value
    }
  }
  if (Object.keys(mergedExtra).length > 0) {
    enriched['extra'] = mergedExtra
  }

  // Contexts: always from global scope
  const contexts = scope.getContext() as Readonly<Record<string, Record<string, unknown>>>
  if (contexts && Object.keys(contexts).length > 0) {
    enriched['contexts'] = contexts
  }

  return enriched
}
