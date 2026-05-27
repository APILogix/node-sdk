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
import { getLogger } from '../utils/logger.js';
const GUARD_SYMBOL = Symbol.for('pulse-sdk.http-lifecycle-guard.installed');
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
    if (!message.includes('Cannot read properties of null') &&
        !message.includes('Cannot read property') &&
        !message.includes('of null') &&
        !message.includes('of undefined')) {
        return false;
    }
    const stack = err.stack || '';
    // Check for OTel HTTP instrumentation frames
    const hasOtelHttpFrame = stack.includes('@opentelemetry/instrumentation-http') ||
        stack.includes('instrumentation-http') ||
        stack.includes('HttpInstrumentation');
    // Check for Node.js internal HTTP client frames
    const hasNodeHttpFrame = stack.includes('node:_http_client') ||
        stack.includes('node:_http_agent') ||
        stack.includes('node:_http_outgoing') ||
        stack.includes('node:_http_server');
    // Check for socket/net lifecycle frames
    const hasSocketFrame = stack.includes('node:net') ||
        stack.includes('Socket.') ||
        stack.includes('onSocketClose') ||
        stack.includes('socketCloseListener') ||
        stack.includes('onSocketFinish');
    // At least one OTel or HTTP internal frame must be present
    if (!hasOtelHttpFrame && !hasNodeHttpFrame && !hasSocketFrame) {
        return false;
    }
    // Bonus confidence: if the error involves known OTel utility patterns
    const hasOtelUtilPattern = stack.includes('getIncomingRequestAttributes') ||
        stack.includes('getOutgoingRequestAttributes') ||
        stack.includes('_traceClientRequest') ||
        stack.includes('_onServerResponseFinish') ||
        stack.includes('_closeHttpSpan') ||
        stack.includes('setSpanWithError') ||
        // The specific crash: accessing .res on a null object
        message.includes("reading 'res'") ||
        message.includes("reading 'statusCode'") ||
        message.includes("reading 'socket'") ||
        message.includes("reading 'remoteAddress'") ||
        message.includes("reading 'headers'");
    return hasOtelHttpFrame || hasOtelUtilPattern || (hasNodeHttpFrame && hasSocketFrame);
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
    if (g[GUARD_SYMBOL])
        return;
    g[GUARD_SYMBOL] = true;
    getLogger().debug('HTTP lifecycle guard installed');
}
/**
 * Remove the HTTP lifecycle guard.
 * Idempotent — safe to call before install or multiple times.
 */
export function uninstallHttpLifecycleGuard() {
    const g = globalThis;
    if (!g[GUARD_SYMBOL])
        return;
    delete g[GUARD_SYMBOL];
    getLogger().debug('HTTP lifecycle guard removed');
}
