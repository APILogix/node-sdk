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
import { context as otelContext, trace } from '@opentelemetry/api';
import { EventEmitter } from 'events';
import { getLogger } from '../utils/logger.js';
const PATCH_SYMBOL = Symbol.for('pulse-sdk.event-emitter-patch.applied');
let originalOn = null;
let originalAddListener = null;
let originalOnce = null;
let originalPrependListener = null;
let originalPrependOnceListener = null;
const contextListenerCache = new WeakMap();
function isSpanEnded(span) {
    if (!span || typeof span !== 'object')
        return true;
    const s = span;
    if (s.ended === true || s._ended === true)
        return true;
    if (typeof s.isRecording === 'function' && !s.isRecording())
        return true;
    return false;
}
function isGlobalOrSystemEmitter(emitter) {
    if (!emitter || typeof emitter !== 'object')
        return false;
    if (typeof process !== 'undefined' && emitter === process) {
        return true;
    }
    const name = emitter?.constructor?.name;
    if (name === 'Process')
        return true;
    if (emitter?.isTTY !== undefined && typeof emitter?.fd === 'number') {
        return true;
    }
    return false;
}
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
    originalPrependListener = EventEmitter.prototype.prependListener;
    originalPrependOnceListener = EventEmitter.prototype.prependOnceListener;
    const bind = (emitter, listener) => {
        if (typeof listener !== 'function' || isGlobalOrSystemEmitter(emitter)) {
            return listener;
        }
        const activeSpan = trace.getActiveSpan();
        if (!activeSpan || isSpanEnded(activeSpan)) {
            return listener;
        }
        const activeCtx = otelContext.active();
        let perContextCache = contextListenerCache.get(activeCtx);
        if (perContextCache) {
            const cached = perContextCache.get(listener);
            if (cached)
                return cached;
        }
        else {
            perContextCache = new WeakMap();
            contextListenerCache.set(activeCtx, perContextCache);
        }
        let contextBound = otelContext.bind(activeCtx, listener);
        let spanRef = activeSpan;
        const wrapper = function contextBoundListener(...args) {
            if (!contextBound || isSpanEnded(spanRef)) {
                contextBound = null;
                spanRef = null;
                listener.apply(this, args);
            }
            else {
                contextBound.apply(this, args);
            }
        };
        Object.defineProperty(wrapper, 'listener', { value: listener, configurable: true });
        perContextCache.set(listener, wrapper);
        return wrapper;
    };
    const bindOnce = (emitter, event, listener, prepend) => {
        if (typeof listener !== 'function' || isGlobalOrSystemEmitter(emitter)) {
            return (prepend ? originalPrependOnceListener : originalOnce).call(emitter, event, listener);
        }
        const activeSpan = trace.getActiveSpan();
        if (!activeSpan || isSpanEnded(activeSpan)) {
            return (prepend ? originalPrependOnceListener : originalOnce).call(emitter, event, listener);
        }
        const activeCtx = otelContext.active();
        let contextBound = otelContext.bind(activeCtx, listener);
        let spanRef = activeSpan;
        const wrapper = function contextBoundOnceListener(...args) {
            this.removeListener(event, wrapper);
            const fn = contextBound && !isSpanEnded(spanRef) ? contextBound : listener;
            contextBound = null;
            spanRef = null;
            fn.apply(this, args);
        };
        Object.defineProperty(wrapper, 'listener', { value: listener, configurable: true });
        return (prepend ? originalPrependListener : originalOn).call(emitter, event, wrapper);
    };
    const patchedOn = function patchedOn(event, listener) {
        return originalOn.call(this, event, bind(this, listener));
    };
    const patchedOnce = function patchedOnce(event, listener) {
        return bindOnce(this, event, listener, false);
    };
    const patchedPrepend = function patchedPrepend(event, listener) {
        return originalPrependListener.call(this, event, bind(this, listener));
    };
    const patchedPrependOnce = function patchedPrependOnce(event, listener) {
        return bindOnce(this, event, listener, true);
    };
    EventEmitter.prototype.on = patchedOn;
    EventEmitter.prototype.addListener = patchedOn;
    EventEmitter.prototype.once = patchedOnce;
    EventEmitter.prototype.prependListener = patchedPrepend;
    EventEmitter.prototype.prependOnceListener = patchedPrependOnce;
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
    if (originalPrependListener)
        EventEmitter.prototype.prependListener = originalPrependListener;
    if (originalPrependOnceListener)
        EventEmitter.prototype.prependOnceListener = originalPrependOnceListener;
    originalOn = null;
    originalAddListener = null;
    originalOnce = null;
    originalPrependListener = null;
    originalPrependOnceListener = null;
    delete g[PATCH_SYMBOL];
    getLogger().debug('EventEmitter context binding patch removed');
}
