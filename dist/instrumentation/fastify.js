/**
 * Fastify request-capture plugin.
 *
 * Mirrors the enterprise hardening of `monitorMiddleware` for Express:
 *   - Killswitch + FeatureController gates
 *   - Tenant admission control
 *   - Centralized scrubbing via SecurityScrubber
 *   - Backend-authoritative sampling and privacy capture policy
 *
 * The plugin is intentionally fail-open. If any hook throws, the host
 * application continues serving traffic and the SDK logs the failure.
 */
import { captureError } from '../capture/captureError.js';
import { captureRequest } from '../capture/captureRequest.js';
import { client } from '../core/client.js';
import { attachRequestContextToActiveSpan, createContextStore, getSpanId, getTraceId, withContext, } from '../core/context.js';
import { getLogger } from '../utils/logger.js';
import { generateId } from '../utils/uuid.js';
import { captureBodySnapshot, evaluateCaptureGate, headerString, matchesIgnoredPath, resolveClientIp, scrubHeaders, scrubQuery, } from './request-capture-utils.js';
export function fastifyPulsePlugin(fastify, opts, done) {
    const options = opts ?? {};
    fastify.addHook('onRequest', (request, _reply, hookDone) => {
        console.log('[DEBUG] fastify onRequest:', request.url);
        try {
            const path = request.url.split('?')[0] || '/';
            if (matchesIgnoredPath(path, options.ignorePaths)) {
                hookDone();
                return;
            }
            // Resolve identity up front so the sampling decision is deterministic.
            const requestId = headerString(request.headers['x-request-id'])
                ?? headerString(request.headers['x-correlation-id'])
                ?? request.id
                ?? generateId();
            const tenantId = headerString(request.headers['x-tenant-id']);
            const decision = evaluateCaptureGate({
                path,
                method: request.method,
                sampleKey: requestId,
                localIgnorePaths: options.ignorePaths,
                localIgnoreMethods: options.ignoreMethods,
            });
            if (!decision.capture) {
                hookDone();
                return;
            }
            const userId = readUserId(request);
            const sessionId = headerString(request.headers['x-session-id']);
            const userAgent = headerString(request.headers['user-agent']);
            const referer = headerString(request.headers['referer'] ?? request.headers['referrer']);
            const clientIp = resolveClientIp(request.headers, request.socket?.remoteAddress, options.trustedProxies, decision.maskIp, request.ip);
            const store = createContextStore(requestId, options.maxBreadcrumbs ?? client.options?.maxBreadcrumbs ?? 100, {
                userId,
                sessionId,
                extra: {
                    ...(tenantId ? { tenantId } : {}),
                    getStatusCode: () => request.raw?.statusCode ?? request.reply?.statusCode,
                    getMethod: () => request.method,
                    getUrl: () => request.url,
                    getRoute: () => normalizedRoute(request),
                },
                tags: { framework: 'fastify' },
            });
            request.pulse = {
                requestId,
                store,
                startTime: Date.now(),
                captured: false,
                tenantId,
                userId,
                sessionId,
                clientIp,
                userAgent,
                referer,
                captureHeaders: decision.allowHeaders,
                captureQuery: decision.allowQuery,
                captureBody: decision.allowBody,
            };
            withContext(store, () => {
                attachRequestContextToActiveSpan(store);
                hookDone();
            });
        }
        catch (err) {
            getLogger().error('fastifyPulsePlugin onRequest failed', { error: err });
            hookDone();
        }
    });
    fastify.addHook('preHandler', (request, _reply, hookDone) => {
        const state = request.pulse;
        if (!state) {
            hookDone();
            return;
        }
        withContext(state.store, () => {
            attachRequestContextToActiveSpan(state.store);
            hookDone();
        });
    });
    fastify.addHook('onResponse', (request, reply, hookDone) => {
        const state = request.pulse;
        if (!state) {
            hookDone();
            return;
        }
        withContext(state.store, () => {
            try {
                captureFastifyCompletion(request, reply, state);
            }
            catch (err) {
                getLogger().error('fastifyPulsePlugin completion failed', { error: err });
            }
            hookDone();
        });
    });
    fastify.addHook('onError', (request, reply, error, hookDone) => {
        console.log('[DEBUG] fastify onError triggered!', error.message, 'reply.statusCode=', reply.statusCode, 'reply.raw.statusCode=', reply.raw?.statusCode);
        const state = request.pulse;
        if (!state) {
            console.log('[DEBUG] no state in request.pulse!');
            hookDone();
            return;
        }
        withContext(state.store, () => {
            try {
                if (state.store.extra) {
                    ;
                    state.store.extra.mechanism = 'fastify.onError';
                    state.store.extra.handled = true;
                }
                attachRequestContextToActiveSpan(state.store);
                captureError(error);
            }
            catch (err) {
                getLogger().error('fastifyPulsePlugin error capture failed', { error: err });
            }
            hookDone();
        });
    });
    done();
}
function captureFastifyCompletion(request, reply, state) {
    if (state.captured)
        return;
    state.captured = true;
    const statusCode = reply.statusCode ?? reply.raw?.statusCode ?? 0;
    const bodySnapshot = captureBodySnapshot(request.body, state.captureBody);
    const responseSize = readContentLength(reply.getHeader?.('content-length'));
    captureRequest({
        type: 'request',
        requestId: state.requestId,
        method: request.method,
        url: normalizedRoute(request),
        statusCode,
        latency: Date.now() - state.startTime,
        timestamp: Date.now(),
        traceId: getTraceId() ?? state.store.traceId,
        spanId: getSpanId() ?? state.store.spanId,
        ...(state.userId ? { userId: state.userId } : {}),
        ...(state.tenantId ? { tenantId: state.tenantId } : {}),
        ...(state.sessionId ? { sessionId: state.sessionId } : {}),
        ...(state.clientIp ? { clientIp: state.clientIp } : {}),
        ...(state.userAgent ? { userAgent: state.userAgent } : {}),
        ...(state.referer ? { referer: state.referer } : {}),
        ...(state.captureHeaders ? { headers: scrubHeadersSafe(request.headers) } : {}),
        ...(state.captureQuery && isRecord(request.query) ? { query: scrubQuery(request.query) } : {}),
        ...(bodySnapshot.body ? { body: bodySnapshot.body } : {}),
        ...(bodySnapshot.bodySize !== undefined ? { bodySize: bodySnapshot.bodySize } : {}),
        ...(responseSize !== undefined ? { responseSize } : {}),
        route: normalizedRoute(request),
    });
}
function normalizedRoute(request) {
    return request.routeOptions?.url ?? request.routerPath ?? request.url.split('?')[0] ?? '/';
}
function readUserId(request) {
    const value = request.user?.id ?? request.user?.userId;
    return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined;
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
//# sourceMappingURL=fastify.js.map