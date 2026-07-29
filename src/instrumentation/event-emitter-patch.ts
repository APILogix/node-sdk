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

import { context as otelContext } from '@opentelemetry/api'
import { EventEmitter } from 'events'
import { getLogger } from '../utils/logger.js'

type ListenerMethod = typeof EventEmitter.prototype.on
type EventListener = (...args: any[]) => void
type RemovableListener = EventListener & { listener?: EventListener }

const PATCH_SYMBOL = Symbol.for('pulse-sdk.event-emitter-patch.applied')

interface GlobalWithPatch {
  [PATCH_SYMBOL]?: boolean
}

let originalOn: ListenerMethod | null = null
let originalAddListener: ListenerMethod | null = null
let originalOnce: ListenerMethod | null = null
let originalPrependListener: ListenerMethod | null = null
let originalPrependOnceListener: ListenerMethod | null = null

/**
 * Patch EventEmitter.prototype to automatically bind listeners to the
 * current OTel context at registration time.
 *
 * Idempotent — safe to call multiple times. Uses a global Symbol guard
 * to prevent double-patching across multiple SDK imports.
 */
export function patchEventEmitter(): void {
  const g = globalThis as typeof globalThis & GlobalWithPatch
  if (g[PATCH_SYMBOL]) return
  g[PATCH_SYMBOL] = true

  originalOn = EventEmitter.prototype.on
  originalAddListener = EventEmitter.prototype.addListener
  originalOnce = EventEmitter.prototype.once
  originalPrependListener = EventEmitter.prototype.prependListener
  originalPrependOnceListener = EventEmitter.prototype.prependOnceListener

  const bind = (listener: EventListener): RemovableListener => {
    const contextBound = otelContext.bind(otelContext.active(), listener)
    const wrapper: RemovableListener = function contextBoundListener(this: unknown, ...args: any[]): void {
      contextBound.apply(this, args)
    }
    // Node's removeListener(event, original) and listeners(event) honor the
    // conventional `.listener` backlink. Keeping it on every context wrapper
    // makes registration fully reversible without retaining emitters in a map.
    Object.defineProperty(wrapper, 'listener', { value: listener, configurable: true })
    return wrapper
  }

  const bindOnce = (
    emitter: EventEmitter,
    event: string | symbol,
    listener: EventListener,
    prepend: boolean,
  ): EventEmitter => {
    const contextBound = otelContext.bind(otelContext.active(), listener)
    const wrapper: RemovableListener = function contextBoundOnceListener(this: EventEmitter, ...args: any[]): void {
      // Remove before invocation, matching EventEmitter.once semantics even
      // when the listener recursively emits the same event.
      this.removeListener(event, wrapper)
      contextBound.apply(this, args)
    }
    Object.defineProperty(wrapper, 'listener', { value: listener, configurable: true })
    return (prepend ? originalPrependListener! : originalOn!).call(emitter, event, wrapper)
  }

  const patchedOn: ListenerMethod = function patchedOn(
    this: EventEmitter,
    event: string | symbol,
    listener: EventListener,
  ): EventEmitter {
    return originalOn!.call(this, event, bind(listener))
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
    return originalPrependListener!.call(this, event, bind(listener))
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
  if (!g[PATCH_SYMBOL]) return

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

  getLogger().debug('EventEmitter context binding patch removed')
}
