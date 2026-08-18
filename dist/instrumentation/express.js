/**
 * Express request-capture middleware.
 *
 * Enterprise-grade integration points:
 *   - KillswitchEngine: short-circuits when SDK or tracing is disabled.
 *   - FeatureController: respects the remote `tracing` feature flag.
 *   - TenantGovernor: atomic per-tenant admission in the canonical pipeline.
 *   - SecurityScrubber: shared scrubbing for headers / query / body.
 *   - ConfigManager: uses the active backend privacy and sampling policy;
 *     middleware ignore lists remain local integration filters only.
 *
 * Span ownership model:
 *   OpenTelemetry HttpInstrumentation owns SERVER span creation when enabled
 *   by remote configuration. This middleware enriches an active span but
 *   never creates a fallback span when HTTP instrumentation is disabled.
 *   It always emits the discrete request event when request capture passes.
 *
 * The AsyncLocalStorage `ContextStore` (request id, breadcrumbs, user/tenant)
 * is established for the request lifetime so descendant work sees consistent
 * SDK context.
 *
 * The middleware is intentionally fail-open: any unexpected error inside
 * the instrumentation path must NEVER take down the host application.
 * Every branch that can throw is wrapped in a defensive try/catch.
 */
import { captureError } from '../capture/captureError.js';
import { captureRequest } from '../capture/captureRequest.js';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import { client } from '../core/client.js';
import { attachRequestContextToActiveSpan, createContextStore, withContext, getRequestContext, getTraceId, getSpanId, } from '../core/context.js';
import { getLogger } from '../utils/logger.js';
import { generateId } from '../utils/uuid.js';
import { captureBodySnapshot, evaluateCaptureGate, headerString, matchesIgnoredPath, resolveClientIp, scrubHeaders, scrubQuery, } from './request-capture-utils.js';
export function monitorMiddleware(options = {}) {
    return function pulseExpressMiddleware(req, res, next) {
        // Resolve the path *once*, defensively. Express attaches `path` only after
        // routing, so callers placing the middleware before any routes still get
        // a usable value via originalUrl/url.
        const path = ((req.path || req.originalUrl || req.url || '/').split('?')[0]) || '/';
        // Cheap framework-level ignore — short-circuits before we touch any
        // SDK engines so misconfigured users still pay near-zero overhead.
        if (matchesIgnoredPath(path, options.ignorePaths)) {
            next();
            return;
        }
        // Resolve request identity *before* the gate so the sampling engine
        // can use a stable id to make a deterministic decision.
        const requestId = headerString(req.headers['x-request-id'])
            ?? headerString(req.headers['x-correlation-id'])
            ?? generateId();
        // Tenant id is needed by the gate; resolve it first so admission control
        // can reject before any allocation.
        const tenantId = headerString(req.headers['x-tenant-id']);
        const decision = evaluateCaptureGate({
            path,
            method: req.method,
            sampleKey: requestId,
            localIgnorePaths: options.ignorePaths,
            localIgnoreMethods: options.ignoreMethods,
        });
        if (!decision.capture) {
            next();
            return;
        }
        // Resolve the rest of the request identity. These values are cheap so
        // we resolve them after the gate to avoid wasting work on dropped
        // requests.
        const userId = readUserId(req);
        const sessionId = headerString(req.headers['x-session-id']);
        const userAgent = headerString(req.headers['user-agent']);
        const referer = headerString(req.headers['referer'] ?? req.headers['referrer']);
        const clientIp = resolveClientIp(req.headers, req.socket?.remoteAddress, options.trustedProxies, decision.maskIp);
        const startTime = Date.now();
        const store = createContextStore(requestId, options.maxBreadcrumbs ?? client.options?.maxBreadcrumbs ?? 100, {
            userId,
            sessionId,
            extra: {
                ...(tenantId ? { tenantId } : {}),
                getStatusCode: () => res.statusCode,
                getMethod: () => req.method,
                getUrl: () => req.originalUrl || req.url,
                getRoute: () => normalizedRoute(req),
            },
            tags: { framework: 'express' },
        });
        // Privacy capture policy is backend-authoritative.
        const captureHeaders = decision.allowHeaders;
        const captureQuery = decision.allowQuery;
        const captureBody = decision.allowBody;
        withContext(store, () => {
            // OpenTelemetry owns SERVER span creation. Middleware only enriches an
            // active span when backend-selected instrumentation created one.
            attachRequestContextToActiveSpan(store);
            let captured = false;
            const captureCompletion = () => {
                if (captured)
                    return;
                captured = true;
                // Re-enter the request's ALS scope so descendants — particularly
                // any captureError() the user calls in onResponse hooks — see the
                // request's ContextStore. The OTel context is preserved by the
                // EventEmitter binding patch, but ALS is a separate channel and
                // must be re-installed explicitly here.
                withContext(store, () => {
                    try {
                        const bodySnapshot = captureBodySnapshot(req.body, captureBody);
                        const responseSize = readContentLength(res.getHeader('content-length'));
                        // Enrich the active backend-selected OpenTelemetry span. Resolve
                        // it at completion because the listener runs in the propagated
                        // request context.
                        const activeSpan = trace.getActiveSpan();
                        if (activeSpan) {
                            const route = normalizedRoute(req);
                            const enrichmentAttrs = {
                                'http.route': route,
                                'http.status_code': res.statusCode,
                                'pulse.request_id': requestId,
                                'pulse.latency_ms': Date.now() - startTime,
                            };
                            if (tenantId)
                                enrichmentAttrs['pulse.tenant_id'] = tenantId;
                            if (userId)
                                enrichmentAttrs['pulse.user_id'] = userId;
                            if (sessionId)
                                enrichmentAttrs['pulse.session_id'] = sessionId;
                            if (clientIp)
                                enrichmentAttrs['http.client_ip'] = clientIp;
                            if (userAgent)
                                enrichmentAttrs['http.user_agent'] = userAgent;
                            if (referer)
                                enrichmentAttrs['http.referer'] = referer;
                            if (bodySnapshot.bodySize !== undefined)
                                enrichmentAttrs['http.request.body.size'] = bodySnapshot.bodySize;
                            if (responseSize !== undefined)
                                enrichmentAttrs['http.response.body.size'] = responseSize;
                            activeSpan.setAttributes(enrichmentAttrs);
                        }
                        // Emit the discrete request event to the canonical requests route.
                        captureRequest({
                            type: 'request',
                            requestId,
                            method: req.method,
                            url: normalizedRoute(req),
                            statusCode: res.statusCode,
                            latency: Date.now() - startTime,
                            timestamp: startTime,
                            traceId: getTraceId() ?? store.traceId,
                            spanId: getSpanId() ?? store.spanId,
                            ...(userId ? { userId } : {}),
                            ...(tenantId ? { tenantId } : {}),
                            ...(sessionId ? { sessionId } : {}),
                            ...(clientIp ? { clientIp } : {}),
                            ...(userAgent ? { userAgent } : {}),
                            ...(referer ? { referer } : {}),
                            ...(captureHeaders ? { headers: scrubHeadersSafe(req.headers) } : {}),
                            ...(captureQuery && isRecord(req.query) ? { query: scrubQuery(req.query) } : {}),
                            ...(bodySnapshot.body ? { body: bodySnapshot.body } : {}),
                            ...(bodySnapshot.bodySize !== undefined ? { bodySize: bodySnapshot.bodySize } : {}),
                            ...(responseSize !== undefined ? { responseSize } : {}),
                            route: normalizedRoute(req),
                        });
                    }
                    catch (err) {
                        // The middleware must NEVER crash the host. Log and move on.
                        getLogger().error('monitorMiddleware completion failed', { error: err });
                    }
                });
            };
            res.once('finish', captureCompletion);
            res.once('close', captureCompletion);
            res.once('error', error => {
                // Re-enter ALS so captureError can pick up the request context
                // (requestId, breadcrumbs, tenantId). Without this withContext
                // wrapper, getRequestContext() inside captureError returns
                // undefined and the error event is emitted without enrichment.
                withContext(store, () => {
                    try {
                        if (store.extra) {
                            ;
                            store.extra.mechanism = 'express.res.error';
                            store.extra.handled = true;
                        }
                        captureError(error);
                        const activeSpan = trace.getActiveSpan();
                        if (activeSpan) {
                            try {
                                activeSpan.recordException(error);
                            }
                            catch { /* fail-open */ }
                        }
                    }
                    catch (err) {
                        getLogger().error('monitorMiddleware error capture failed', { error: err });
                    }
                });
            });
            // Intercept next(err) — errors routed to Express error-handling
            // middleware never hit the response 'error' event, so without this
            // they would never be captured. Plain next() calls pass through
            // untouched.
            const wrappedNext = (err) => {
                if (err) {
                    const error = err instanceof Error ? err : new Error(String(err));
                    withContext(store, () => {
                        try {
                            if (store.extra) {
                                ;
                                store.extra.mechanism = 'express.next';
                                store.extra.handled = true;
                            }
                            captureError(error);
                            const activeSpan = trace.getActiveSpan();
                            if (activeSpan) {
                                try {
                                    activeSpan.recordException(error);
                                    activeSpan.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
                                }
                                catch { /* fail-open */ }
                            }
                        }
                        catch (captureErr) {
                            getLogger().error('monitorMiddleware next(err) capture failed', { error: captureErr });
                        }
                    });
                }
                next(err);
            };
            wrappedNext();
        });
    };
}
/**
 * Express error-handling middleware. Place after all routes and before custom error responses.
 * Automatically captures any error passed to next(err) or thrown in route handlers.
 *
 * @example
 * ```ts
 * app.use(monitorMiddleware())
 * // ... routes ...
 * app.use(expressErrorHandler())
 * ```
 */
export function expressErrorHandler() {
    return function pulseExpressErrorHandler(err, req, res, next) {
        if (err) {
            try {
                const store = getRequestContext();
                if (store && store.extra) {
                    ;
                    store.extra.mechanism = 'express.next';
                    store.extra.handled = true;
                }
                const error = err instanceof Error ? err : new Error(String(err));
                captureError(error);
            }
            catch {
                // Error capture must remain fail-open
            }
        }
        next(err);
    };
}
// ─── Helpers ────────────────────────────────────────────────────────────────
function normalizedRoute(req) {
    const routePath = routePathToString(req.route?.path);
    if (routePath) {
        const base = req.baseUrl && req.baseUrl !== '/' ? req.baseUrl : '';
        return `${base}${routePath}`;
    }
    return (req.path || req.originalUrl || req.url || '').split('?')[0] || '/';
}
function routePathToString(path) {
    if (typeof path === 'string')
        return path;
    if (path instanceof RegExp)
        return path.source;
    return undefined;
}
function readUserId(req) {
    const user = req.user;
    const value = user?.id ?? user?.userId;
    return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined;
}
function readContentLength(value) {
    if (typeof value === 'number' && Number.isFinite(value))
        return value;
    if (typeof value === 'string') {
        const parsed = Number.parseInt(value, 10);
        return Number.isFinite(parsed) ? parsed : undefined;
    }
    if (Array.isArray(value) && value.length > 0) {
        const parsed = Number.parseInt(String(value[0]), 10);
        return Number.isFinite(parsed) ? parsed : undefined;
    }
    return undefined;
}
function scrubHeadersSafe(headers) {
    try {
        const clone = {};
        for (const [key, value] of Object.entries(headers))
            clone[key] = value;
        return scrubHeaders(clone) ?? {};
    }
    catch {
        return {};
    }
}
function isRecord(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}
//# sourceMappingURL=express.js.map