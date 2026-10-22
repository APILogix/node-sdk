/**
 * EventEmitter context binding — ensures event listeners preserve the
 * async context (trace ID, span, request context) that was active when
 * the listener was registered.
 *
 * Without this patch, EventEmitter listeners fire in the context of the
 * emitter, not the registrar. This causes trace IDs to detach and child
 * spans to become orphaned when EventEmitter is used inside request handlers.
 *
 * Patch is idempotent (global Symbol guard) and fully reversible.
 */

import { context as otelContext, trace, type Context } from '@opentelemetry/api'
import { EventEmitter } from 'events'
import { getLogger } from '../utils/logger.js'

type ListenerMethod = typeof EventEmitter.prototype.on
type EventListener = (...args: any[]) => void
type RemovableListener = EventListener & { listener?: EventListener }

const PATCH_SYMBOL = Symbol.for('lynktrace.event-emitter-patch.applied')
const PATCH_SYMBOL_LEGACY = Symbol.for('pulse-sdk.event-emitter-patch.applied')

interface GlobalWithPatch {
  [PATCH_SYMBOL]?: boolean
  [PATCH_SYMBOL_LEGACY]?: boolean
}

let originalOn: ListenerMethod | null = null
let originalAddListener: ListenerMethod | null = null
let originalOnce: ListenerMethod | null = null
let originalPrependListener: ListenerMethod | null = null
let originalPrependOnceListener: ListenerMethod | null = null

const contextListenerCache = new WeakMap<Context, WeakMap<EventListener, RemovableListener>>()

function isSpanEnded(span: unknown): boolean {
  if (!span || typeof span !== 'object') return true
  const s = span as { ended?: boolean; _ended?: boolean; isRecording?: () => boolean }
  if (s.ended === true || s._ended === true) return true
  if (typeof s.isRecording === 'function' && !s.isRecording()) return true
  return false
}

function isGlobalOrSystemEmitter(emitter: unknown): boolean {
  if (!emitter || typeof emitter !== 'object') return false
  if (typeof process !== 'undefined' && emitter === process) {
    return true
  }
  const name = (emitter as any)?.constructor?.name
  if (name === 'Process') return true
  if ((emitter as any)?.isTTY !== undefined && typeof (emitter as any)?.fd === 'number') {
    return true
  }
  return false
}

/**
 * Patch EventEmitter.prototype to automatically bind listeners to the
 * current OTel context at registration time.
 *
 * Idempotent — safe to call multiple times. Uses a global Symbol guard
 * to prevent double-patching across multiple SDK imports.
 */
export function patchEventEmitter(): void {
  const g = globalThis as typeof globalThis & GlobalWithPatch
  if (g[PATCH_SYMBOL] || g[PATCH_SYMBOL_LEGACY]) return
  g[PATCH_SYMBOL] = true
  g[PATCH_SYMBOL_LEGACY] = true

  originalOn = EventEmitter.prototype.on
  originalAddListener = EventEmitter.prototype.addListener
  originalOnce = EventEmitter.prototype.once
  originalPrependListener = EventEmitter.prototype.prependListener
  originalPrependOnceListener = EventEmitter.prototype.prependOnceListener

  const bind = (emitter: EventEmitter, listener: EventListener): EventListener => {
    if (typeof listener !== 'function' || isGlobalOrSystemEmitter(emitter)) {
      return listener
    }

    const activeSpan = trace.getActiveSpan()
    if (!activeSpan || isSpanEnded(activeSpan)) {
      return listener
    }

    const activeCtx = otelContext.active()
    let perContextCache = contextListenerCache.get(activeCtx)
    if (perContextCache) {
      const cached = perContextCache.get(listener)
      if (cached) return cached
    } else {
      perContextCache = new WeakMap<EventListener, RemovableListener>()
      contextListenerCache.set(activeCtx, perContextCache)
    }

    let contextBound: EventListener | null = otelContext.bind(activeCtx, listener)
    let spanRef: unknown = activeSpan

    const wrapper: RemovableListener = function contextBoundListener(this: unknown, ...args: any[]): void {
      if (!contextBound || isSpanEnded(spanRef)) {
        contextBound = null
        spanRef = null
        listener.apply(this, args)
      } else {
        contextBound.apply(this, args)
      }
    }

    Object.defineProperty(wrapper, 'listener', { value: listener, configurable: true })
    perContextCache.set(listener, wrapper)
    return wrapper
  }

  const bindOnce = (
    emitter: EventEmitter,
    event: string | symbol,
    listener: EventListener,
    prepend: boolean,
  ): EventEmitter => {
    if (typeof listener !== 'function' || isGlobalOrSystemEmitter(emitter)) {
      return (prepend ? originalPrependOnceListener! : originalOnce!).call(emitter, event, listener)
    }

    const activeSpan = trace.getActiveSpan()
    if (!activeSpan || isSpanEnded(activeSpan)) {
      return (prepend ? originalPrependOnceListener! : originalOnce!).call(emitter, event, listener)
    }

    const activeCtx = otelContext.active()
    let contextBound: EventListener | null = otelContext.bind(activeCtx, listener)
    let spanRef: unknown = activeSpan

    const wrapper: RemovableListener = function contextBoundOnceListener(this: EventEmitter, ...args: any[]): void {
      this.removeListener(event, wrapper)
      const fn = contextBound && !isSpanEnded(spanRef) ? contextBound : listener
      contextBound = null
      spanRef = null
      fn.apply(this, args)
    }
    Object.defineProperty(wrapper, 'listener', { value: listener, configurable: true })
    return (prepend ? originalPrependListener! : originalOn!).call(emitter, event, wrapper)
  }

  const patchedOn: ListenerMethod = function patchedOn(
    this: EventEmitter,
    event: string | symbol,
    listener: EventListener,
  ): EventEmitter {
    return originalOn!.call(this, event, bind(this, listener))
  }

  const patchedOnce: ListenerMethod = function patchedOnce(
    this: EventEmitter,
    event: string | symbol,
    listener: EventListener,
  ): EventEmitter {
    return bindOnce(this, event, listener, false)
  }

  const patchedPrepend: ListenerMethod = function patchedPrepend(
    this: EventEmitter,
    event: string | symbol,
    listener: EventListener,
  ): EventEmitter {
    return originalPrependListener!.call(this, event, bind(this, listener))
  }

  const patchedPrependOnce: ListenerMethod = function patchedPrependOnce(
    this: EventEmitter,
    event: string | symbol,
    listener: EventListener,
  ): EventEmitter {
    return bindOnce(this, event, listener, true)
  }

  EventEmitter.prototype.on = patchedOn
  EventEmitter.prototype.addListener = patchedOn
  EventEmitter.prototype.once = patchedOnce
  EventEmitter.prototype.prependListener = patchedPrepend
  EventEmitter.prototype.prependOnceListener = patchedPrependOnce

  getLogger().debug('EventEmitter context binding patch applied')
}

/**
 * Remove the EventEmitter context binding patch.
 * Restores original prototype methods.
 *
 * Idempotent — safe to call before patchEventEmitter or multiple times.
 */
export function unpatchEventEmitter(): void {
  const g = globalThis as typeof globalThis & GlobalWithPatch
  if (!g[PATCH_SYMBOL] && !g[PATCH_SYMBOL_LEGACY]) return

  if (originalOn) EventEmitter.prototype.on = originalOn
  if (originalAddListener) EventEmitter.prototype.addListener = originalAddListener
  if (originalOnce) EventEmitter.prototype.once = originalOnce
  if (originalPrependListener) EventEmitter.prototype.prependListener = originalPrependListener
  if (originalPrependOnceListener) EventEmitter.prototype.prependOnceListener = originalPrependOnceListener

  originalOn = null
  originalAddListener = null
  originalOnce = null
  originalPrependListener = null
  originalPrependOnceListener = null
  delete g[PATCH_SYMBOL]
  delete g[PATCH_SYMBOL_LEGACY]

  getLogger().debug('EventEmitter context binding patch removed')
}
