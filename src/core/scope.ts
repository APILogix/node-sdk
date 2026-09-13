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

import { context as otelContext, createContextKey } from '@opentelemetry/api'
import { getRequestContext } from './context.js'
import { RingBuffer } from './ring-buffer.js'
import type { Breadcrumb } from '../types/breadcrumb.js'
import { getLogger } from '../utils/logger.js'
import { SecurityScrubber } from '../processors/security-scrubber.js'

// ─── OTel Context Key ───────────────────────────────────────────────────────

/**
 * Context key for scope storage on the OTel context.
 * This enables ALS propagation of scope through all async operations.
 */
const SCOPE_KEY = createContextKey('pulse-sdk-scope')

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

// ─── Scope Manager ──────────────────────────────────────────────────────────

export class ScopeManager {
  private user: User | null = null
  private tags: Record<string, string> = Object.create(null)
  private extra: Record<string, unknown> = Object.create(null)
  private contexts: Record<string, Record<string, unknown>> = Object.create(null)

  // ─── User Identification ──────────────────────────────────────────────

  /**
   * Set the current user. This user will be attached to all subsequent events.
   * Pass null to clear the user.
   */
  setUser(user: User | null): void {
    this.user = user ? scrubUser(user) : null
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
    if (!isSafeKey(key)) return
    this.tags[key] = value
  }

  /**
   * Set multiple tags at once.
   */
  setTags(tags: Record<string, string>): void {
    for (const [key, value] of Object.entries(tags)) {
      if (isSafeKey(key)) this.tags[key] = value
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
    if (!isSafeKey(key)) return
    this.extra[key] = value
  }

  /**
   * Set multiple extra context entries at once.
   */
  setExtras(extras: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(extras)) {
      if (isSafeKey(key)) this.extra[key] = value
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
    if (!isSafeKey(name)) return
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

// ─── Global Scope Fallback ──────────────────────────────────────────────────

/**
 * Module-level global scope. Used as the fallback when no request-local
 * scope exists on the OTel context (i.e., outside any `withScope()` block
 * or request middleware).
 */
export const scopeManager = new ScopeManager()

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
function getActiveScope(): ScopeManager {
  const ctxScope = otelContext.active().getValue(SCOPE_KEY) as ScopeManager | undefined
  return ctxScope ?? scopeManager
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
export function setUser(user: User | null): void {
  getActiveScope().setUser(user)
}

/**
 * Set a single tag key/value pair in the active scope.
 * @example
 * ```ts
 * setTag('environment', 'production')
 * ```
 */
export function setTag(key: string, value: string): void {
  getActiveScope().setTag(key, value)
}

/**
 * Set multiple tags at once in the active scope.
 */
export function setTags(tags: Record<string, string>): void {
  getActiveScope().setTags(tags)
}

/**
 * Remove a tag by key from the active scope.
 */
export function removeTag(key: string): void {
  getActiveScope().removeTag(key)
}

/**
 * Set a single extra context key/value in the active scope.
 */
export function setExtra(key: string, value: unknown): void {
  getActiveScope().setExtra(key, value)
}

/**
 * Set multiple extra context entries at once in the active scope.
 */
export function setExtras(extras: Record<string, unknown>): void {
  getActiveScope().setExtras(extras)
}

/**
 * Remove an extra context entry by key from the active scope.
 */
export function removeExtra(key: string): void {
  getActiveScope().removeExtra(key)
}

/**
 * Set a named context object in the active scope.
 * @example
 * ```ts
 * setContext('device', { model: 'iPhone 15', os: 'iOS 17' })
 * ```
 */
export function setContext(name: string, context: Record<string, unknown> | null): void {
  getActiveScope().setContext(name, context)
}

/**
 * Get scope data snapshot from the active scope.
 */
export function getScopeData(): ScopeData {
  return getActiveScope().getScopeData()
}

/**
 * Clear all scope data in the active scope.
 */
export function clearScope(): void {
  getActiveScope().clear()
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
export function withScope<T>(fn: (scope: ScopeManager) => T): T {
  const cloned = getActiveScope().clone()
  const ctx = otelContext.active().setValue(SCOPE_KEY, cloned)
  return otelContext.with(ctx, () => fn(cloned))
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
export function applyScopeToEvent(event: Record<string, unknown>): Record<string, unknown> {
  const ctx = getRequestContext()
  const scope = getActiveScope()

  const enriched: Record<string, unknown> = { ...event }

  // User: context userId takes precedence, then active scope user
  if (ctx?.userId && !enriched['user']) {
    enriched['user'] = { id: ctx.userId }
  } else if (scope.getUser() && !enriched['user']) {
    enriched['user'] = scope.getUser()
  }

  // Tags: merge active scope tags with context tags (context wins)
  const mergedTags: Record<string, string> = { ...scope.getTags() }
  if (ctx?.tags) {
    for (const [key, value] of Object.entries(ctx.tags)) {
      mergedTags[key] = value
    }
  }
  if (Object.keys(mergedTags).length > 0) {
    enriched['tags'] = mergedTags
  }

  // Extra: merge active scope extra with context extra (context wins)
  // Enterprise guard: Functions and non-cloneable objects must NEVER leak into
  // event payloads (prevents DataCloneError during Worker serialization).
  const mergedExtra: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(scope.getExtras())) {
    if (typeof value !== 'function' && typeof value !== 'symbol') {
      mergedExtra[key] = value
    }
  }
  if (ctx?.extra) {
    for (const [key, value] of Object.entries(ctx.extra)) {
      if (typeof value !== 'function' && typeof value !== 'symbol') {
        mergedExtra[key] = value
      }
    }
  }
  if (Object.keys(mergedExtra).length > 0) {
    enriched['extra'] = mergedExtra
  }

  // Contexts: from active scope
  const contexts = scope.getContext() as Readonly<Record<string, Record<string, unknown>>>
  if (contexts && Object.keys(contexts).length > 0) {
    enriched['contexts'] = contexts
  }

  return enriched
}

// ─── Security Helpers ───────────────────────────────────────────────────────

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

function isSafeKey(key: string): boolean {
  return key !== '__proto__' && key !== 'constructor' && key !== 'prototype'
}

function scrubUser(user: User): User {
  const scrubber = SecurityScrubber.getInstance()
  const scrub = (value: string | undefined): string | undefined => {
    if (!value) return value
    if (!scrubber) return value
    try {
      return scrubber.scrubValue(value) as string
    } catch {
      return value
    }
  }

  return {
    ...user,
    email: scrub(user.email),
    username: scrub(user.username),
    ipAddress: scrub(user.ipAddress),
    data: user.data ? scrubObjectValues(user.data) : undefined,
  }
}

function scrubObjectValues(obj: Record<string, unknown>): Record<string, unknown> {
  const scrubber = SecurityScrubber.getInstance()
  if (!scrubber) return { ...obj }
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(obj)) {
    if (isSafeKey(key)) {
      result[key] = scrubber.scrubValue(value)
    }
  }
  return result
}
