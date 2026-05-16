/**
 * Fastify Framework Instrumentation — automatic request tracing and telemetry.
 *
 * Provides a Fastify plugin that:
 * - Creates per-request async context with trace/span IDs
 * - Automatically captures request events (method, URL, status, latency)
 * - Adds HTTP breadcrumbs
 * - Injects trace context into response headers for downstream consumers
 * - Extracts incoming trace context from request headers (W3C propagation)
 *
 * Usage:
 *   import Fastify from 'fastify'
 *   import { fastifyPulsePlugin } from '@vikasbaplawat1/pulse-sdk'
 *
 *   const app = Fastify()
 *   app.register(fastifyPulsePlugin)
 */
import { withContext, createContextStore, addBreadcrumb } from '../core/context.js';
import { captureRequest } from '../capture/captureRequest.js';
import { extractTraceContext, injectTraceContext } from '../tracing/context-propagation.js';
import { startSpan } from '../tracing/tracer.js';
import { getLogger } from '../utils/logger.js';
import { generateId } from '../utils/uuid.js';
/**
 * Fastify plugin for Pulse SDK instrumentation.
 * Register with `app.register(fastifyPulsePlugin)`.
 */
export function fastifyPulsePlugin(fastify, opts, done) {
    const logger = getLogger();
    const ignorePaths = new Set(opts.ignorePaths ?? ['/health', '/ready', '/healthz', '/livez']);
    const captureHeaders = opts.captureHeaders ?? true;
    const captureQuery = opts.captureQuery ?? true;
    const maxBreadcrumbs = opts.maxBreadcrumbs ?? 100;
    fastify.addHook('onRequest', (request, _reply, hookDone) => {
        const req = request;
        const next = hookDone;
        // Skip ignored paths
        const path = req.url.split('?')[0] ?? '';
        if (ignorePaths.has(path)) {
            next();
            return;
        }
        // Extract incoming trace context from headers
        extractTraceContext(req.headers);
        // Start a server span for this request
        const span = startSpan(`${req.method} ${req.url}`, {
            attributes: {
                'http.method': req.method,
                'http.url': req.url,
                'http.host': req.hostname,
                'http.user_agent': String(req.headers['user-agent'] ?? 'unknown'),
                'span.kind': 'SERVER',
            },
        });
        // Create SDK context store
        const store = createContextStore(req.headers['x-request-id'] ?? generateId(), maxBreadcrumbs, {
            traceId: span.traceId,
            spanId: span.spanId,
            userId: req.headers['x-user-id'] ?? undefined,
        });
        // Stash span and metadata on request for later hooks
        const reqRecord = req;
        reqRecord.__pulseSpan = span;
        reqRecord.__pulseStore = store;
        reqRecord.__pulseStartTime = Date.now();
        // Activate the context so getRequestContext() works in route handlers
        withContext(store, () => {
            next();
        });
    });
    fastify.addHook('onResponse', (request, reply, hookDone) => {
        const req = request;
        const rep = reply;
        const next = hookDone;
        const path = req.url.split('?')[0] ?? '';
        if (ignorePaths.has(path)) {
            next();
            return;
        }
        const reqRecord = req;
        const span = reqRecord.__pulseSpan;
        const startTime = reqRecord.__pulseStartTime;
        const latency = startTime ? Date.now() - startTime : 0;
        const statusCode = rep.statusCode;
        // End the span
        if (span) {
            span.setAttribute('http.status_code', statusCode);
            span.setStatus(statusCode >= 400 ? 'error' : 'ok');
            span.end();
        }
        // Inject trace context into response headers
        const responseHeaders = {};
        injectTraceContext(responseHeaders);
        for (const [key, value] of Object.entries(responseHeaders)) {
            rep.header(key, value);
        }
        // Capture the request event
        try {
            captureRequest({
                type: 'request',
                requestId: req.headers['x-request-id'] ?? generateId(),
                url: req.url,
                method: req.method,
                statusCode,
                latency,
                timestamp: Date.now(),
                headers: captureHeaders ? sanitizeHeaders(req.headers) : undefined,
                query: captureQuery ? req.query : undefined,
            });
        }
        catch (err) {
            logger.error('captureRequest failed in Fastify plugin', { error: err });
        }
        // Add breadcrumb
        try {
            const level = statusCode >= 500 ? 'error' : statusCode >= 400 ? 'warning' : 'info';
            addBreadcrumb({
                category: 'http',
                message: `${req.method} ${req.url} [${statusCode}] ${latency}ms`,
                level,
                type: 'http',
                data: {
                    method: req.method,
                    url: req.url,
                    statusCode,
                    duration: latency,
                    direction: 'inbound',
                },
            });
        }
        catch {
            // Non-critical
        }
        next();
    });
    logger.info('Fastify Pulse SDK plugin registered', {
        ignorePaths: [...ignorePaths],
    });
    done();
}
// ─── Utilities ──────────────────────────────────────────────────────────────
const SENSITIVE_HEADERS = new Set([
    'authorization',
    'cookie',
    'set-cookie',
    'x-api-key',
    'x-auth-token',
    'proxy-authorization',
]);
function sanitizeHeaders(headers) {
    const sanitized = {};
    for (const [key, value] of Object.entries(headers)) {
        if (SENSITIVE_HEADERS.has(key.toLowerCase())) {
            sanitized[key] = '[REDACTED]';
        }
        else {
            sanitized[key] = value;
        }
    }
    return sanitized;
}
//# sourceMappingURL=fastify.js.map