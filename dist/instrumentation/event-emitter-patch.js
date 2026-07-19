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
import { context as otelContext } from '@opentelemetry/api';
import { EventEmitter } from 'events';
import { getLogger } from '../utils/logger.js';
const PATCH_SYMBOL = Symbol.for('pulse-sdk.event-emitter-patch.applied');
let originalOn = null;
let originalAddListener = null;
let originalOnce = null;
/**
 * Patch EventEmitter.prototype to automatically bind listeners to the
 * current OTel context at registration time.
 *
 * Idempotent — safe to call multiple times. Uses a global Symbol guard
 * to prevent double-patching across multiple SDK imports.
 */
export function patchEventEmitter() {
    const g = globalThis;
    if (g[PATCH_SYMBOL])
        return;
    g[PATCH_SYMBOL] = true;
    originalOn = EventEmitter.prototype.on;
    originalAddListener = EventEmitter.prototype.addListener;
    originalOnce = EventEmitter.prototype.once;
    const patchedOn = function patchedOn(event, listener) {
        const bound = otelContext.bind(otelContext.active(), listener);
        return originalOn.call(this, event, bound);
    };
    const patchedOnce = function patchedOnce(event, listener) {
        const bound = otelContext.bind(otelContext.active(), listener);
        return originalOnce.call(this, event, bound);
    };
    EventEmitter.prototype.on = patchedOn;
    EventEmitter.prototype.addListener = patchedOn;
    EventEmitter.prototype.once = patchedOnce;
    getLogger().debug('EventEmitter context binding patch applied');
}
/**
 * Remove the EventEmitter context binding patch.
 * Restores original prototype methods.
 *
 * Idempotent — safe to call before patchEventEmitter or multiple times.
 */
export function unpatchEventEmitter() {
    const g = globalThis;
    if (!g[PATCH_SYMBOL])
        return;
    if (originalOn)
        EventEmitter.prototype.on = originalOn;
    if (originalAddListener)
        EventEmitter.prototype.addListener = originalAddListener;
    if (originalOnce)
        EventEmitter.prototype.once = originalOnce;
    originalOn = null;
    originalAddListener = null;
    originalOnce = null;
    delete g[PATCH_SYMBOL];
    getLogger().debug('EventEmitter context binding patch removed');
}
//# sourceMappingURL=event-emitter-patch.js.map