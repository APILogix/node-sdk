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
import { trace, context, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { client } from '../core/client.js';
import { attachRequestContextToActiveSpan, createContextStore, withContext, getRequestContext, getTraceId, getSpanId, } from '../core/context.js';
import { FeatureController } from '../core/feature-controller.js';
import { KillswitchEngine } from '../core/killswitch-engine.js';
import { ConfigManager } from '../core/config-manager.js';
import { SDK_NAME, SDK_VERSION } from '../constants/version.js';
import { getLogger } from '../utils/logger.js';
import { generateId } from '../utils/uuid.js';
import { extractTraceContext } from '../tracing/context-propagation.js';
import { startSpan } from '../tracing/tracer.js';
import { getTraceAggregator } from '../tracing/trace-aggregator.js';
import { captureBodySnapshot, evaluateCaptureGate, headerString, matchesIgnoredPath, resolveClientIp, scrubHeaders, scrubQuery, } from './request-capture-utils.js';
const LAYER_PATCH_GUARD = Symbol.for('pulse-sdk.express.layer-patched');
function isLayerIgnored(name, ignoreMiddlewares) {
    if (!ignoreMiddlewares || ignoreMiddlewares.length === 0)
        return false;
    return ignoreMiddlewares.some((pattern) => {
        if (typeof pattern === 'string')
            return name === pattern;
        if (pattern instanceof RegExp)
            return pattern.test(name);
        return false;
    });
}
/**
 * Patch Express Layer.prototype once to measure middleware execution durations.
 * Only emits spans if duration >= minDurationMs or if an error is encountered.
 */
export function ensureExpressLayersInstrumented(app, minDurationMs = 2, ignoreMiddlewares) {
    try {
        const globalState = globalThis;
        if (globalState[LAYER_PATCH_GUARD])
            return;
        const router = app?.router || app?._router;
        if (!router || !Array.isArray(router.stack) || router.stack.length === 0)
            return;
        const firstLayer = router.stack[0];
        if (!firstLayer)
            return;
        const layerProto = Object.getPrototypeOf(firstLayer);
        if (!layerProto)
            return;
        // Express 5: handleRequest / handleError; Express 4: handle_request / handle_error
        const handleMethod = typeof layerProto.handleRequest === 'function'
            ? 'handleRequest'
            : (typeof layerProto.handle_request === 'function' ? 'handle_request' : null);
        if (!handleMethod)
            return;
        const originalHandle = layerProto[handleMethod];
        if (typeof originalHandle !== 'function')
            return;
        layerProto[handleMethod] = function pulseLayerHandle(req, res, next) {
            try {
                const layerName = this?.name || (this?.handle && this.handle.name) || '<anonymous>';
                if (layerName === 'pulseExpressMiddleware' ||
                    layerName === 'expressInit' ||
                    layerName === 'query' ||
                    layerName === 'router' ||
                    isLayerIgnored(layerName, ignoreMiddlewares)) {
                    return originalHandle.call(this, req, res, next);
                }
                let activeSpan = null;
                try {
                    activeSpan = trace.getActiveSpan();
                }
                catch { }
                if (!activeSpan) {
                    return originalHandle.call(this, req, res, next);
                }
                const startTime = Date.now();
                let startHr;
                try {
                    startHr = process.hrtime.bigint();
                }
                catch {
                    startHr = BigInt(0);
                }
                let recorded = false;
                const recordTiming = (err) => {
                    if (recorded)
                        return;
                    recorded = true;
                    try {
                        let durationMs = 0;
                        if (startHr !== BigInt(0)) {
                            const endHr = process.hrtime.bigint();
                            durationMs = Number(endHr - startHr) / 1e6;
                        }
                        else {
                            durationMs = Date.now() - startTime;
                        }
                        if (durationMs >= minDurationMs || err) {
                            const span = startSpan(`express.middleware - ${layerName}`, {
                                startTime,
                                kind: 'internal',
                                attributes: {
                                    'express.layer.name': layerName,
                                    'express.layer.type': 'middleware',
                                    'express.layer.duration_ms': Math.round(durationMs * 100) / 100,
                                },
                            });
                            if (err) {
                                const error = err instanceof Error ? err : new Error(String(err));
                                span.recordError(error);
                                span.setStatus('error', error.message);
                            }
                            else {
                                span.setStatus('ok');
                            }
                            span.end(startTime + Math.max(1, durationMs));
                        }
                    }
                    catch {
                        // Fail-open
                    }
                };
                const onFinish = () => recordTiming();
                if (res && typeof res.once === 'function') {
                    try {
                        res.once('finish', onFinish);
                    }
                    catch { }
                }
                const wrappedNext = (err) => {
                    try {
                        if (res && typeof res.removeListener === 'function') {
                            res.removeListener('finish', onFinish);
                        }
                    }
                    catch { }
                    recordTiming(err);
                    return next(err);
                };
                try {
                    return originalHandle.call(this, req, res, wrappedNext);
                }
                catch (syncErr) {
                    try {
                        if (res && typeof res.removeListener === 'function') {
                            res.removeListener('finish', onFinish);
                        }
                    }
                    catch { }
                    recordTiming(syncErr);
                    throw syncErr;
                }
            }
            catch (layerErr) {
                // Fail-open: if instrumentation fails, run originalHandle directly
                return originalHandle.call(this, req, res, next);
            }
        };
        globalState[LAYER_PATCH_GUARD] = true;
    }
    catch {
        // Fail-open: layer instrumentation failure should never break host app
    }
}
/**
 * Programmatically instrument an Express Application to profile middleware execution.
 */
export function instrumentExpress(app, options) {
    ensureExpressLayersInstrumented(app, options?.minMiddlewareDurationMs ?? 2, options?.ignoreMiddlewares);
}
export function monitorMiddleware(options = {}) {
    return function pulseExpressMiddleware(req, res, next) {
        let nextCalled = false;
        const safeNext = (err) => {
            if (!nextCalled) {
                nextCalled = true;
                next(err);
            }
        };
        try {
            // Resolve the path *once*, defensively. Express attaches `path` only after
            // routing, so callers placing the middleware before any routes still get
            // a usable value via originalUrl/url.
            if (options.instrumentMiddleware && req?.app) {
                try {
                    ensureExpressLayersInstrumented(req.app, options.minMiddlewareDurationMs ?? 2, options.ignoreMiddlewares);
                }
                catch {
                    // Fail-open
                }
            }
            let path = '/';
            try {
                path = ((req?.path || req?.originalUrl || req?.url || '/').split('?')[0]) || '/';
            }
            catch {
                path = '/';
            }
            // Cheap framework-level ignore — short-circuits before we touch any
            // SDK engines so misconfigured users still pay near-zero overhead.
            if (matchesIgnoredPath(path, options.ignorePaths)) {
                safeNext();
                return;
            }
            // Resolve request identity *before* the gate so the sampling engine
            // can use a stable id to make a deterministic decision.
            const headers = req?.headers || {};
            const requestId = headerString(headers['x-request-id'])
                ?? headerString(headers['x-correlation-id'])
                ?? generateId();
            // Tenant id is needed by the gate; resolve it first so admission control
            // can reject before any allocation.
            const tenantId = headerString(headers['x-tenant-id']);
            let decision = {
                capture: false,
                allowHeaders: false,
                allowQuery: false,
                allowBody: false,
                allowResponse: false,
                allowCookies: false,
                maskIp: true,
                sampledRate: 0,
            };
            try {
                decision = evaluateCaptureGate({
                    path,
                    method: req?.method ?? 'GET',
                    sampleKey: requestId,
                    localIgnorePaths: options.ignorePaths,
                    localIgnoreMethods: options.ignoreMethods,
                });
            }
            catch {
                safeNext();
                return;
            }
            if (!decision.capture) {
                safeNext();
                return;
            }
            // Resolve the rest of the request identity. These values are cheap so
            // we resolve them after the gate to avoid wasting work on dropped
            // requests.
            const userId = readUserId(req);
            const sessionId = headerString(headers['x-session-id']);
            const userAgent = headerString(headers['user-agent']);
            const referer = headerString(headers['referer'] ?? headers['referrer']);
            const clientIp = resolveClientIp(headers, req?.socket?.remoteAddress, options.trustedProxies, decision.maskIp);
            const startTime = Date.now();
            const extra = tenantId ? { tenantId } : {};
            try {
                Object.defineProperties(extra, {
                    getStatusCode: { value: () => res?.statusCode, enumerable: false, configurable: true, writable: true },
                    getMethod: { value: () => req?.method, enumerable: false, configurable: true, writable: true },
                    getUrl: { value: () => req?.originalUrl || req?.url, enumerable: false, configurable: true, writable: true },
                    getRoute: { value: () => normalizedRoute(req), enumerable: false, configurable: true, writable: true },
                });
            }
            catch { }
            const store = createContextStore(requestId, options.maxBreadcrumbs ?? 100, {
                userId,
                sessionId,
                extra,
                tags: { framework: 'express' },
            });
            // Privacy capture policy is backend-authoritative.
            const captureHeaders = decision.allowHeaders;
            const captureQuery = decision.allowQuery;
            const captureBody = decision.allowBody;
            const configManager = ConfigManager.getInstance();
            let httpInstrumentationEnabled = false;
            try {
                const config = configManager.getConfigOrNull();
                httpInstrumentationEnabled = Boolean(config?.instrumentation?.http);
            }
            catch { }
            let activeSpan = trace.getActiveSpan() ?? req?.__pulseServerSpan;
            let createdServerSpan = false;
            let isTracingActive = false;
            try {
                const featureCtrl = FeatureController.getInstance();
                const killswitchEngine = KillswitchEngine.getInstance();
                isTracingActive = !killswitchEngine?.isKilled('disableTracing') && (!featureCtrl || featureCtrl.isEnabled('tracing'));
            }
            catch { }
            let parentContext = undefined;
            try {
                parentContext = extractTraceContext(headers);
            }
            catch { }
            // Create server span if no active span exists (e.g. direct middleware invocation, synthetic tests, or custom server)
            if (!activeSpan && isTracingActive) {
                try {
                    const tracer = trace.getTracer(SDK_NAME, SDK_VERSION);
                    activeSpan = tracer.startSpan(`HTTP ${req?.method ?? 'GET'} ${path}`, {
                        kind: SpanKind.SERVER,
                        attributes: {
                            'http.method': req?.method ?? 'GET',
                            'http.url': req?.originalUrl || req?.url,
                            'http.route': path,
                            'http.target': req?.url,
                            ...(req?.headers?.host ? { 'http.host': req.headers.host } : {}),
                            ...(headers['host'] ? { 'http.host': String(headers['host']) } : {}),
                            ...(userAgent ? { 'http.user_agent': userAgent } : {}),
                            ...(clientIp ? { 'http.client_ip': clientIp } : {}),
                        },
                    }, parentContext ?? context.active());
                    createdServerSpan = true;
                }
                catch {
                    // Fail-open: tracing creation failure should never affect request processing
                }
            }
            const runInScope = () => {
                try {
                    withContext(store, () => {
                        try {
                            attachRequestContextToActiveSpan(store);
                        }
                        catch { }
                        let captured = false;
                        const captureCompletion = () => {
                            if (captured)
                                return;
                            captured = true;
                            const statusCode = res?.statusCode ?? 200;
                            const latencyMs = Date.now() - startTime;
                            const responseSize = typeof res?.getHeader === 'function' ? readContentLength(res.getHeader('content-length')) : undefined;
                            const rawBody = req?.body;
                            const rawReqHeaders = req?.headers;
                            const rawReqQuery = req?.query;
                            const route = normalizedRoute(req);
                            const currentActiveSpan = trace.getActiveSpan() ?? activeSpan;
                            if (currentActiveSpan) {
                                try {
                                    if (typeof currentActiveSpan.updateName === 'function') {
                                        ;
                                        currentActiveSpan.updateName(`HTTP ${req?.method ?? 'GET'} ${route}`);
                                    }
                                    const enrichmentAttrs = {
                                        'http.route': route,
                                        'http.status_code': statusCode,
                                        'pulse.request_id': requestId,
                                        'pulse.latency_ms': latencyMs,
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
                                    if (responseSize !== undefined)
                                        enrichmentAttrs['http.response.body.size'] = responseSize;
                                    currentActiveSpan.setAttributes(enrichmentAttrs);
                                    if (res && res.statusCode >= 500) {
                                        currentActiveSpan.setStatus({ code: SpanStatusCode.ERROR });
                                    }
                                    else if (res && res.statusCode >= 100 && res.statusCode < 400) {
                                        currentActiveSpan.setStatus({ code: SpanStatusCode.OK });
                                    }
                                }
                                catch { }
                            }
                            if (createdServerSpan && activeSpan) {
                                try {
                                    const serverSpan = activeSpan;
                                    const traceId = serverSpan.spanContext().traceId;
                                    let ended = false;
                                    const endServerSpan = () => {
                                        if (ended)
                                            return;
                                        ended = true;
                                        try {
                                            serverSpan.end();
                                        }
                                        catch (endErr) {
                                            getLogger().error('Failed to end server span', { error: endErr });
                                        }
                                    };
                                    const aggregator = getTraceAggregator();
                                    if (aggregator.getActiveSpanCount(traceId) > 1) {
                                        aggregator.waitForActiveChildren(traceId, endServerSpan, 10000);
                                    }
                                    else {
                                        endServerSpan();
                                    }
                                }
                                catch { }
                            }
                            // SEC-05: Defer heavy body snapshotting, PII scrubbing, and captureRequest
                            // via setImmediate so the HTTP response cycle returns instantly to the event loop.
                            setImmediate(() => {
                                withContext(store, () => {
                                    try {
                                        const bodySnapshot = captureBodySnapshot(rawBody, captureBody);
                                        if (currentActiveSpan && bodySnapshot.bodySize !== undefined) {
                                            try {
                                                currentActiveSpan.setAttribute('http.request.body.size', bodySnapshot.bodySize);
                                            }
                                            catch { }
                                        }
                                        // Emit the discrete request event to the canonical requests route.
                                        captureRequest({
                                            type: 'request',
                                            requestId,
                                            method: req?.method ?? 'GET',
                                            url: route,
                                            statusCode,
                                            latency: latencyMs,
                                            timestamp: startTime,
                                            traceId: getTraceId() ?? store.traceId ?? activeSpan?.spanContext()?.traceId,
                                            spanId: getSpanId() ?? store.spanId ?? activeSpan?.spanContext()?.spanId,
                                            ...(userId ? { userId } : {}),
                                            ...(tenantId ? { tenantId } : {}),
                                            ...(sessionId ? { sessionId } : {}),
                                            ...(clientIp ? { clientIp } : {}),
                                            ...(userAgent ? { userAgent } : {}),
                                            ...(referer ? { referer } : {}),
                                            ...(captureHeaders ? { headers: scrubHeadersSafe(rawReqHeaders) } : {}),
                                            ...(captureHeaders ? { headers: scrubHeadersSafe(headers) } : {}),
                                            ...(captureQuery && isRecord(rawReqQuery) ? { query: scrubQuery(rawReqQuery) } : {}),
                                            ...(bodySnapshot.body ? { body: bodySnapshot.body } : {}),
                                            ...(bodySnapshot.bodySize !== undefined ? { bodySize: bodySnapshot.bodySize } : {}),
                                            ...(responseSize !== undefined ? { responseSize } : {}),
                                            route,
                                        });
                                    }
                                    catch (err) {
                                        getLogger().error('monitorMiddleware completion failed', { error: err });
                                    }
                                });
                            });
                        };
                        if (res && typeof res.once === 'function') {
                            try {
                                res.once('finish', captureCompletion);
                                res.once('close', captureCompletion);
                                res.once('error', error => {
                                    withContext(store, () => {
                                        try {
                                            if (store.extra) {
                                                ;
                                                store.extra.mechanism = 'express.res.error';
                                                store.extra.handled = true;
                                            }
                                            captureError(error);
                                            const currentActiveSpan = trace.getActiveSpan() ?? activeSpan;
                                            if (currentActiveSpan) {
                                                try {
                                                    currentActiveSpan.recordException(error);
                                                    currentActiveSpan.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
                                                }
                                                catch { /* fail-open */ }
                                            }
                                        }
                                        catch (err) {
                                            getLogger().error('monitorMiddleware error capture failed', { error: err });
                                        }
                                    });
                                });
                            }
                            catch { }
                        }
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
                                        const currentActiveSpan = trace.getActiveSpan() ?? activeSpan;
                                        if (currentActiveSpan) {
                                            try {
                                                currentActiveSpan.recordException(error);
                                                currentActiveSpan.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
                                            }
                                            catch { /* fail-open */ }
                                        }
                                    }
                                    catch (captureErr) {
                                        getLogger().error('monitorMiddleware next(err) capture failed', { error: captureErr });
                                    }
                                });
                            }
                            safeNext(err);
                        };
                        wrappedNext();
                    });
                }
                catch {
                    safeNext();
                }
            };
            if (activeSpan) {
                try {
                    context.with(trace.setSpan(parentContext ?? context.active(), activeSpan), runInScope);
                }
                catch {
                    runInScope();
                }
            }
            else {
                runInScope();
            }
        }
        catch (unhandledErr) {
            try {
                getLogger().error('monitorMiddleware unhandled exception', { error: unhandledErr });
            }
            catch { }
            safeNext();
        }
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
        try {
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
                    const activeSpan = trace.getActiveSpan();
                    if (activeSpan) {
                        try {
                            activeSpan.recordException(error);
                            activeSpan.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
                        }
                        catch { /* fail-open */ }
                    }
                }
                catch {
                    // Error capture must remain fail-open
                }
            }
        }
        catch {
            // Fail-open
        }
        finally {
            if (typeof next === 'function') {
                next(err);
            }
        }
    };
}
// ─── Helpers ────────────────────────────────────────────────────────────────
function normalizedRoute(req) {
    try {
        const routePath = routePathToString(req?.route?.path);
        if (routePath) {
            const base = req?.baseUrl && req.baseUrl !== '/' ? req.baseUrl : '';
            return `${base}${routePath}`;
        }
        return (req?.path || req?.originalUrl || req?.url || '').split('?')[0] || '/';
    }
    catch {
        return '/';
    }
}
function routePathToString(path) {
    if (typeof path === 'string')
        return path;
    if (path instanceof RegExp)
        return path.source;
    return undefined;
}
function readUserId(req) {
    try {
        const user = req?.user;
        const value = user?.id ?? user?.userId;
        return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined;
    }
    catch {
        return undefined;
    }
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
    if (!headers || typeof headers !== 'object')
        return {};
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
