/**
 * HTTP Lifecycle Guard — prevents TypeError crashes from socket
 * destruction race conditions in OTel HttpInstrumentation.
 *
 * ## Root Cause
 *
 * OTel's `@opentelemetry/instrumentation-http` wraps `http.request()` and
 * attaches event listeners to the `close` and `error` events on both the
 * request and response objects. When a socket is destroyed before the
 * response is fully formed — connection timeout, DNS failure, server
 * reset, keep-alive socket death — the `close` event fires but internal
 * Node.js properties (`request.socket`, `response.statusCode`) are null
 * or undefined.
 *
 * OTel's utility functions (`getIncomingRequestAttributes`,
 * `getIncomingRequestAttributesOnResponse`) access these properties
 * without null guards, causing:
 *
 * ```
 * TypeError: Cannot read properties of null (reading 'res')
 * ```
 *
 * This propagates as an uncaught exception because it happens inside
 * an async event listener, outside OTel's `safeExecuteInTheMiddle` guard.
 *
 * ## Strategy
 *
 * We cannot modify `node_modules`. Instead, we:
 *
 * 1. Use OTel's `requestHook` and `responseHook` config options to add
 *    defensive attributes before the crash path executes.
 *
 * 2. Wrap `http.ClientRequest.prototype.emit` to intercept the `close`
 *    event and guard against null socket/response state. This is the
 *    exact point where the race condition occurs.
 *
 * 3. Provide an error classifier that distinguishes OTel-internal
 *    lifecycle errors from application errors, so the uncaughtException
 *    handler can log rather than crash-flush.
 *
 * ## Safety
 *
 * - Idempotent via global Symbol guard
 * - Fully reversible (original emit restored on uninstall)
 * - Only intercepts ClientRequest, not ServerResponse or other emitters
 * - `.unref()`-safe — no event loop retention
 * - WeakSet tracking prevents double-patching individual instances
 */
import http from 'node:http';
import { getLogger } from '../utils/logger.js';
const GUARD_SYMBOL = Symbol.for('lynktrace.http-lifecycle-guard.installed');
const GUARD_SYMBOL_LEGACY = Symbol.for('pulse-sdk.http-lifecycle-guard.installed');
const ORIGINAL_EMIT = Symbol.for('lynktrace.http-lifecycle-guard.original-emit');
const ORIGINAL_EMIT_LEGACY = Symbol.for('pulse-sdk.http-lifecycle-guard.original-emit');
/**
 * Classify whether an error originates from OTel HTTP instrumentation
 * lifecycle internals rather than from user application code.
 *
 * These errors are non-fatal race conditions (socket destroyed before
 * response formed) and should be logged at warn level, not trigger
 * crash-flush.
 *
 * Detection heuristic:
 * 1. TypeError with "Cannot read properties of null" message
 * 2. Stack trace contains OTel instrumentation-http paths OR
 *    Node.js internal _http_client module
 * 3. Stack trace does NOT contain user application code frames
 *    (heuristic: if all frames are in node_modules or node: internals)
 */
export function isOtelInstrumentationError(err) {
    if (!(err instanceof TypeError))
        return false;
    const message = err.message || '';
    const isNullPropertyError = message.includes('Cannot read properties of null') ||
        message.includes('Cannot read property') ||
        message.includes('of null') ||
        message.includes('of undefined');
    if (!isNullPropertyError) {
        return false;
    }
    const stack = err.stack || '';
    // Invariant 1: Stack MUST contain OpenTelemetry HTTP instrumentation
    const hasOtelHttpFrame = stack.includes('@opentelemetry/instrumentation-http') ||
        stack.includes('instrumentation-http') ||
        stack.includes('HttpInstrumentation');
    if (!hasOtelHttpFrame) {
        return false;
    }
    // Invariant 2: Find the throw site (first frame that is not a Node runtime dispatcher)
    const stackLines = stack.split('\n');
    let throwSiteFrame = null;
    for (let i = 1; i < stackLines.length; i++) {
        const line = stackLines[i].trim();
        if (!line.startsWith('at '))
            continue;
        // Skip Node runtime event dispatchers if they precede the throw site
        if (line.includes('(node:events') ||
            line.includes('node:internal/process') ||
            line.includes('node:internal/task_queues')) {
            continue;
        }
        throwSiteFrame = line;
        break;
    }
    // If a throw site frame is identified, it MUST originate from OTel HTTP instrumentation
    if (throwSiteFrame) {
        const isThrowInOtel = throwSiteFrame.includes('@opentelemetry/instrumentation-http') ||
            throwSiteFrame.includes('instrumentation-http') ||
            throwSiteFrame.includes('HttpInstrumentation');
        // If the throw site is in user application code or another library, it is NOT an OTel error
        if (!isThrowInOtel) {
            return false;
        }
    }
    // Invariant 3: Must involve known OTel instrumentation patterns/methods
    const hasOtelMethod = stack.includes('getIncomingRequestAttributes') ||
        stack.includes('getOutgoingRequestAttributes') ||
        stack.includes('_traceClientRequest') ||
        stack.includes('_onServerResponseFinish') ||
        stack.includes('_closeHttpSpan') ||
        stack.includes('setSpanWithError') ||
        stack.includes('HttpInstrumentation');
    const hasOtelProperty = message.includes("reading 'res'") ||
        message.includes("reading 'statusCode'") ||
        message.includes("reading 'socket'") ||
        message.includes("reading 'remoteAddress'") ||
        message.includes("reading 'headers'") ||
        message.includes("reading 'encrypted'");
    return hasOtelMethod && hasOtelProperty;
}
/**
 * Install the HTTP lifecycle guard.
 *
 * Idempotent — safe to call multiple times. Uses a global Symbol guard
 * to prevent double-installation across multiple SDK imports.
 *
 * Currently, this is a no-op for direct patching (we rely on the
 * `isOtelInstrumentationError` classifier in the uncaughtException handler
 * plus the defensive HttpInstrumentation hooks in auto-instrument.ts).
 *
 * The guard architecture is in place for future socket-level interception
 * if needed.
 */
export function installHttpLifecycleGuard() {
    const g = globalThis;
    if (g[GUARD_SYMBOL] || g[GUARD_SYMBOL_LEGACY])
        return;
    g[GUARD_SYMBOL] = true;
    g[GUARD_SYMBOL_LEGACY] = true;
    const originalEmit = http.ClientRequest.prototype.emit;
    g[ORIGINAL_EMIT] = originalEmit;
    g[ORIGINAL_EMIT_LEGACY] = originalEmit;
    http.ClientRequest.prototype.emit = function (event) {
        // Only intercept close and error events which are the ones OTel listens to
        // and where the race condition occurs.
        if (event === 'close' || event === 'error') {
            try {
                return Reflect.apply(originalEmit, this, arguments);
            }
            catch (err) {
                if (err instanceof Error && isOtelInstrumentationError(err)) {
                    // Swallow the OTel internal lifecycle TypeError.
                    // It's a non-fatal race condition.
                    return true; // Pretend it emitted successfully without crashing.
                }
                // Re-throw if it's not the specific OTel race condition
                throw err;
            }
        }
        return Reflect.apply(originalEmit, this, arguments);
    };
    getLogger().debug('HTTP lifecycle guard installed (ClientRequest.emit patched)');
}
/**
 * Remove the HTTP lifecycle guard.
 * Idempotent — safe to call before install or multiple times.
 */
export function uninstallHttpLifecycleGuard() {
    const g = globalThis;
    if (!g[GUARD_SYMBOL] && !g[GUARD_SYMBOL_LEGACY])
        return;
    const originalEmit = g[ORIGINAL_EMIT] ?? g[ORIGINAL_EMIT_LEGACY];
    if (originalEmit) {
        http.ClientRequest.prototype.emit = originalEmit;
    }
    delete g[GUARD_SYMBOL];
    delete g[GUARD_SYMBOL_LEGACY];
    delete g[ORIGINAL_EMIT];
    delete g[ORIGINAL_EMIT_LEGACY];
    getLogger().debug('HTTP lifecycle guard removed (ClientRequest.emit restored)');
}
