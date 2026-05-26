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

const PATCH_SYMBOL = Symbol.for('pulse-sdk.event-emitter-patch.applied')

interface GlobalWithPatch {
  [PATCH_SYMBOL]?: boolean
}

let originalOn: typeof EventEmitter.prototype.on | null = null
let originalAddListener: typeof EventEmitter.prototype.addListener | null = null
let originalOnce: typeof EventEmitter.prototype.once | null = null

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

  const patchedOn: typeof EventEmitter.prototype.on = function patchedOn(
    this: EventEmitter,
    event: string | symbol,
    listener: (...args: any[]) => void,
  ): EventEmitter {
    const bound = otelContext.bind(otelContext.active(), listener)
    return originalOn!.call(this, event, bound)
  }

  const patchedOnce: typeof EventEmitter.prototype.once = function patchedOnce(
    this: EventEmitter,
    event: string | symbol,
    listener: (...args: any[]) => void,
  ): EventEmitter {
    const bound = otelContext.bind(otelContext.active(), listener)
    return originalOnce!.call(this, event, bound)
  }

  EventEmitter.prototype.on = patchedOn
  EventEmitter.prototype.addListener = patchedOn
  EventEmitter.prototype.once = patchedOnce

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

  originalOn = null
  originalAddListener = null
  originalOnce = null
  delete g[PATCH_SYMBOL]

  getLogger().debug('EventEmitter context binding patch removed')
}
