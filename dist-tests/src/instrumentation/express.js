/**
 * Express request-capture middleware.
 *
 * Enterprise-grade integration points:
 *   - KillswitchEngine: short-circuits when SDK or tracing is disabled.
 *   - FeatureController: respects the remote `tracing` feature flag.
 *   - TenantGovernor: per-tenant admission control before any work.
 *   - SecurityScrubber: shared scrubbing for headers / query / body.
 *   - ConfigManager: honours `tracing.ignoredRoutes`, `tracing.ignoredMethods`,
 *     and `tracing.capture.*` so a single remote-config flip changes capture
 *     behaviour at runtime — no redeploy.
 *
 * The middleware is intentionally fail-open: any unexpected error inside the
 * instrumentation path must NEVER take down the host application. Every
 * branch that can throw is wrapped in a defensive try/catch.
 */
import { captureError } from '../capture/captureError.js';
import { captureRequest } from '../capture/captureRequest.js';
import { client } from '../core/client.js';
import { attachRequestContextToActiveSpan, createContextStore, getSpanId, getTraceId, withContext, } from '../core/context.js';
import { getLogger } from '../utils/logger.js';
import { generateId } from '../utils/uuid.js';
import { captureBodySnapshot, evaluateCaptureGate, headerString, matchesIgnoredPath, recordCaptureAccepted, resolveClientIp, scrubHeaders, scrubQuery, } from './request-capture-utils.js';
const SENSITIVE_HEADER_FALLBACK = /authorization|cookie|token|secret|password/i;
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
        // Tenant id is needed by the gate; resolve it first so admission control
        // can reject before any allocation.
        const tenantId = headerString(req.headers['x-tenant-id']);
        const decision = evaluateCaptureGate({
            path,
            method: req.method,
            tenantId,
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
        const requestId = headerString(req.headers['x-request-id'])
            ?? headerString(req.headers['x-correlation-id'])
            ?? generateId();
        const userId = readUserId(req);
        const sessionId = headerString(req.headers['x-session-id']);
        const userAgent = headerString(req.headers['user-agent']);
        const referer = headerString(req.headers['referer'] ?? req.headers['referrer']);
        const clientIp = resolveClientIp(req.headers, req.socket?.remoteAddress);
        const startTime = Date.now();
        const store = createContextStore(requestId, options.maxBreadcrumbs ?? client.config?.maxBreadcrumbs ?? 100, {
            userId,
            sessionId,
            extra: tenantId ? { tenantId } : undefined,
            tags: { framework: 'express' },
        });
        // Local override resolution. `undefined` means "follow remote config".
        const captureHeaders = options.captureHeaders ?? decision.allowHeaders;
        const captureQuery = options.captureQuery ?? decision.allowQuery;
        const captureBody = options.captureBody ?? decision.allowBody;
        withContext(store, () => {
            attachRequestContextToActiveSpan(store);
            let captured = false;
            const captureCompletion = () => {
                if (captured)
                    return;
                captured = true;
                try {
                    const bodySnapshot = captureBodySnapshot(req.body, captureBody);
                    const responseSize = readContentLength(res.getHeader('content-length'));
                    recordCaptureAccepted(tenantId);
                    captureRequest({
                        type: 'request',
                        requestId,
                        method: req.method,
                        url: normalizedRoute(req),
                        statusCode: res.statusCode,
                        latency: Date.now() - startTime,
                        timestamp: Date.now(),
                        traceId: getTraceId() ?? store.traceId,
                        spanId: getSpanId() ?? store.spanId,
                        ...(userId ? { userId } : {}),
                        ...(tenantId ? { tenantId } : {}),
                        ...(sessionId ? { sessionId } : {}),
                        ...(clientIp ? { clientIp } : {}),
                        ...(userAgent ? { userAgent } : {}),
                        ...(referer ? { referer } : {}),
                        ...(captureHeaders ? { headers: scrubHeadersSafe(req.headers) } : {}),
                        ...(captureQuery ? { query: scrubQuery(req.query) } : {}),
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
            };
            res.once('finish', captureCompletion);
            res.once('close', captureCompletion);
            res.once('error', error => {
                try {
                    captureError(error, {
                        context: {
                            requestId,
                            route: normalizedRoute(req),
                            framework: 'express',
                            ...(tenantId ? { tenantId } : {}),
                        },
                    });
                }
                catch (err) {
                    getLogger().error('monitorMiddleware error capture failed', { error: err });
                }
            });
            next();
        });
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
/**
 * Wrap `scrubHeaders` so the middleware can swallow defensive errors without
 * losing the request entirely. The shared helper already falls back, but in
 * the (theoretical) case it throws we still want to emit the event.
 */
function scrubHeadersSafe(headers) {
    try {
        const clone = {};
        for (const [key, value] of Object.entries(headers)) {
            clone[key] = value;
        }
        return scrubHeaders(clone) ?? defensiveHeaderRedact(clone);
    }
    catch {
        return defensiveHeaderRedact(headers);
    }
}
function defensiveHeaderRedact(headers) {
    const out = {};
    for (const [key, value] of Object.entries(headers)) {
        out[key] = SENSITIVE_HEADER_FALLBACK.test(key) ? '[Redacted]' : value;
    }
    return out;
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
