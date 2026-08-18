import { AsyncLocalStorage } from 'async_hooks'
import { context as otelContext, createContextKey, trace } from '@opentelemetry/api'
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
 * Metadata carried on the OpenTelemetry context.
 *
 * Trace/span ownership belongs exclusively to OTel. The SDK stores request
 * metadata, breadcrumbs, user/session data, tags, and extra context here.
 */
export interface ContextStore {
  /** Unique request identifier. */
  readonly requestId: string
  /** OpenTelemetry trace ID at context creation time. Prefer getTraceId(). */
  readonly traceId?: string | undefined
  /** OpenTelemetry span ID at context creation time. Prefer getSpanId(). */
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

const CONTEXT_STORE_KEY = createContextKey('pulse-sdk-context-store')
const contextStorage = new AsyncLocalStorage<ContextStore>()

export const PULSE_CONTEXT_ATTRIBUTES = {
  requestId: 'pulse.request_id',
  sessionId: 'pulse.session_id',
  userId: 'pulse.user_id',
  tenantId: 'pulse.tenant_id',
} as const

// ─── Context Accessors ──────────────────────────────────────────────────────

/**
 * Get the current request context, or undefined if outside a context scope.
 */
export function getRequestContext(): ContextStore | undefined {
  return contextStorage.getStore()
    ?? otelContext.active().getValue(CONTEXT_STORE_KEY) as ContextStore | undefined
}

export function getRequestContextFromOtelContext(ctx = otelContext.active()): ContextStore | undefined {
  return ctx.getValue(CONTEXT_STORE_KEY) as ContextStore | undefined
}

/**
 * Get the current trace ID from context, or undefined.
 * Synchronizes traceId with ContextStore so correlation is preserved
 * even after child spans finish and pop off the active context stack.
 */
export function getTraceId(): string | undefined {
  const activeSpan = trace.getActiveSpan()
  if (activeSpan) {
    const traceId = activeSpan.spanContext().traceId
    if (traceId) {
      const store = getRequestContext()
      if (store && !store.traceId) {
        ;(store as { traceId?: string }).traceId = traceId
      }
      return traceId
    }
  }
  return getRequestContext()?.traceId
}

/**
 * Get the current span ID from context, or undefined.
 * Synchronizes spanId with ContextStore so correlation is preserved
 * even after child spans finish and pop off the active context stack.
 */
export function getSpanId(): string | undefined {
  const activeSpan = trace.getActiveSpan()
  if (activeSpan) {
    const spanId = activeSpan.spanContext().spanId
    if (spanId) {
      const store = getRequestContext()
      if (store && !store.spanId) {
        ;(store as { spanId?: string }).spanId = spanId
      }
      return spanId
    }
  }
  return getRequestContext()?.spanId
}

export function attachRequestContextToActiveSpan(store = getRequestContext()): void {
  if (!store) return

  const activeSpan = trace.getActiveSpan()
  if (!activeSpan) return

  const spanContext = activeSpan.spanContext()
  if (spanContext) {
    if (!store.traceId && spanContext.traceId) {
      ;(store as { traceId?: string }).traceId = spanContext.traceId
    }
    if (!store.spanId && spanContext.spanId) {
      ;(store as { spanId?: string }).spanId = spanContext.spanId
    }
  }

  const tenantId = store.extra?.['tenantId']
  const attributes: Record<string, string> = {
    [PULSE_CONTEXT_ATTRIBUTES.requestId]: store.requestId,
  }

  if (store.sessionId) attributes[PULSE_CONTEXT_ATTRIBUTES.sessionId] = store.sessionId
  if (store.userId) attributes[PULSE_CONTEXT_ATTRIBUTES.userId] = store.userId
  if (typeof tenantId === 'string' && tenantId) attributes[PULSE_CONTEXT_ATTRIBUTES.tenantId] = tenantId

  try {
    activeSpan.setAttributes(attributes)
  } catch {
    // Span mutation must never affect application control flow.
  }
}

// ─── Context Mutation (within scope) ────────────────────────────────────────

/**
 * Add a breadcrumb to the current request context.
 * No-op if called outside a context scope.
 */
export function addBreadcrumb(input: BreadcrumbInput): void {
  const store = getRequestContext()
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
  const store = getRequestContext()
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
  const activeSpanContext = trace.getActiveSpan()?.spanContext()
  return {
    requestId,
    traceId: activeSpanContext?.traceId ?? overrides?.traceId,
    spanId: activeSpanContext?.spanId ?? overrides?.spanId,
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
  const ctx = otelContext.active().setValue(CONTEXT_STORE_KEY, store)
  return contextStorage.run(store, () => otelContext.with(ctx, () => {
    attachRequestContextToActiveSpan(store)
    return fn()
  }))
}

export function bindContext<T extends (...args: never[]) => unknown>(
  fn: T,
  store = getRequestContext(),
): T {
  if (!store) return fn

  return function boundContext(this: unknown, ...args: Parameters<T>): ReturnType<T> {
    return withContext(store, () => fn.apply(this, args)) as ReturnType<T>
  } as T
}
