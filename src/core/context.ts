import { AsyncLocalStorage } from 'async_hooks'
import type { Breadcrumb, BreadcrumbInput } from '../types/breadcrumb.js'
import type { BreadcrumbHint } from '../types/breadcrumb.js'
import type { SeverityLevel } from '../types/severity.js'
import { Severity } from '../types/severity.js'
import { isoNow } from '../utils/time.js'
import { RingBuffer } from './ring-buffer.js'
import { client } from './client.js'
import { getLogger } from '../utils/logger.js'

// ─── Context Store ──────────────────────────────────────────────────────────

/**
 * The async context store — propagated through promises, timers, callbacks.
 * Every request gets its own isolated store via AsyncLocalStorage.run().
 */
export interface ContextStore {
  /** Unique request identifier. */
  readonly requestId: string
  /** OpenTelemetry trace ID (if tracing enabled). */
  readonly traceId?: string | undefined
  /** OpenTelemetry span ID (if tracing enabled). */
  readonly spanId?: string | undefined
  /** User identifier for user-scoped telemetry. */
  readonly userId?: string | undefined
  /** Session identifier. */
  readonly sessionId?: string | undefined
  /** W3C Baggage entries propagated across service boundaries. */
  readonly baggage?: Readonly<Record<string, string>> | undefined
  /** Breadcrumb ring buffer — bounded, auto-evicting. */
  readonly breadcrumbs: RingBuffer<Breadcrumb>
  /** Custom tags for this request scope. */
  readonly tags?: Readonly<Record<string, string>> | undefined
  /** Arbitrary extra context data. */
  readonly extra?: Readonly<Record<string, unknown>> | undefined
}

// ─── AsyncLocalStorage Instance ─────────────────────────────────────────────

export const asyncLocalStorage = new AsyncLocalStorage<ContextStore>()

// ─── Context Accessors ──────────────────────────────────────────────────────

/**
 * Get the current request context, or undefined if outside a context scope.
 */
export function getRequestContext(): ContextStore | undefined {
  return asyncLocalStorage.getStore()
}

/**
 * Get the current trace ID from context, or undefined.
 */
export function getTraceId(): string | undefined {
  return asyncLocalStorage.getStore()?.traceId
}

/**
 * Get the current span ID from context, or undefined.
 */
export function getSpanId(): string | undefined {
  return asyncLocalStorage.getStore()?.spanId
}

// ─── Context Mutation (within scope) ────────────────────────────────────────

/**
 * Add a breadcrumb to the current request context.
 * No-op if called outside a context scope.
 */
export function addBreadcrumb(input: BreadcrumbInput): void {
  const store = asyncLocalStorage.getStore()
  if (!store) return

  let breadcrumb: Breadcrumb = {
    timestamp: isoNow(),
    category: input.category,
    message: input.message,
    level: input.level ?? Severity.Info,
    type: input.type ?? 'default',
    data: input.data,
  }

  const logger = getLogger()
  const hint: BreadcrumbHint = input.data === undefined
    ? { originalEvent: input }
    : { originalEvent: input, data: input.data }

  if (client.options?.beforeBreadcrumb) {
    try {
      const result = client.options.beforeBreadcrumb(breadcrumb, hint)
      if (result === null) return
      breadcrumb = result
    } catch (error) {
      logger.warn('beforeBreadcrumb threw', { error })
    }
  }

  if (client.initialized) {
    for (const plugin of client.plugins) {
      if (!plugin.processBreadcrumb) continue
      try {
        const result = plugin.processBreadcrumb(breadcrumb, hint)
        if (result === null) return
        breadcrumb = result
      } catch (error) {
        logger.warn('Plugin processBreadcrumb threw', {
          pluginName: plugin.meta.name,
          error,
        })
      }
    }
  }

  store.breadcrumbs.push(breadcrumb)
}

/**
 * Get all breadcrumbs from the current request context.
 * Returns an empty array if outside a context scope.
 */
export function getBreadcrumbs(): readonly Breadcrumb[] {
  const store = asyncLocalStorage.getStore()
  if (!store) return []
  return store.breadcrumbs.toArray()
}

// ─── Context Factory ────────────────────────────────────────────────────────

/**
 * Create a new ContextStore with defaults.
 * Used by instrumentation middleware to establish per-request context.
 */
export function createContextStore(
  requestId: string,
  maxBreadcrumbs: number,
  overrides?: Partial<Omit<ContextStore, 'requestId' | 'breadcrumbs'>>
): ContextStore {
  return {
    requestId,
    traceId: overrides?.traceId,
    spanId: overrides?.spanId,
    userId: overrides?.userId,
    sessionId: overrides?.sessionId,
    baggage: overrides?.baggage,
    breadcrumbs: new RingBuffer<Breadcrumb>(maxBreadcrumbs),
    tags: overrides?.tags,
    extra: overrides?.extra,
  }
}

/**
 * Run a function within an async context scope.
 * The context is automatically propagated through all async operations.
 */
export function withContext<T>(store: ContextStore, fn: () => T): T {
  return asyncLocalStorage.run(store, fn)
}
