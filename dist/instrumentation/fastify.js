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
import { trace, context, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { client } from '../core/client.js';
import { attachRequestContextToActiveSpan, createContextStore, getSpanId, getTraceId, withContext, } from '../core/context.js';
import { FeatureController } from '../core/feature-controller.js';
import { KillswitchEngine } from '../core/killswitch-engine.js';
import { SDK_NAME, SDK_VERSION } from '../constants/version.js';
import { getLogger } from '../utils/logger.js';
import { generateId } from '../utils/uuid.js';
import { extractTraceContext } from '../tracing/context-propagation.js';
import { captureBodySnapshot, evaluateCaptureGate, headerString, matchesIgnoredPath, resolveClientIp, scrubHeaders, scrubQuery, } from './request-capture-utils.js';
export function fastifyPulsePlugin(fastify, opts, done) {
    const options = opts ?? {};
    fastify.addHook('onRequest', (request, _reply, hookDone) => {
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
            const tracer = trace.getTracer(SDK_NAME, SDK_VERSION);
            let activeSpan = trace.getActiveSpan();
            let createdServerSpan = false;
            const featureCtrl = FeatureController.getInstance();
            const killswitchEngine = KillswitchEngine.getInstance();
            const isTracingActive = !killswitchEngine?.isKilled('disableTracing') && (!featureCtrl || featureCtrl.isEnabled('tracing'));
            const parentContext = extractTraceContext(request.headers);
            if (!activeSpan && isTracingActive) {
                try {
                    activeSpan = tracer.startSpan(`HTTP ${request.method} ${path}`, {
                        kind: SpanKind.SERVER,
                        attributes: {
                            'http.method': request.method,
                            'http.url': request.url,
                            'http.route': path,
                            'http.target': request.url,
                            ...(request.headers.host ? { 'http.host': String(request.headers.host) } : {}),
                            ...(userAgent ? { 'http.user_agent': userAgent } : {}),
                            ...(clientIp ? { 'http.client_ip': clientIp } : {}),
                        },
                    }, parentContext);
                    createdServerSpan = true;
                }
                catch {
                    // Fail-open
                }
            }
            request.pulse = {
                requestId,
                store,
                startTime: Date.now(),
                captured: false,
                activeSpan,
                createdServerSpan,
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
            const runHook = () => {
                withContext(store, () => {
                    attachRequestContextToActiveSpan(store);
                    hookDone();
                });
            };
            if (createdServerSpan && activeSpan) {
                context.with(trace.setSpan(parentContext ?? context.active(), activeSpan), runHook);
            }
            else {
                runHook();
            }
        }
        catch (err) {
            getLogger().error('fastifyPulsePlugin onRequest failed', { error: err });
            hookDone();
        }
    });
    fastify.addHook('preHandler', (request, reply, hookDone) => {
        const state = request.pulse;
        if (!state) {
            hookDone();
            return;
        }
        const rawReply = reply;
        if (typeof rawReply.send === 'function') {
            const originalSend = rawReply.send;
            rawReply.send = function (payload) {
                if (state && !state.store.extra?.['fastifyErrorCaptured']) {
                    const errStatusCode = payload?.statusCode
                        ?? (rawReply.statusCode && rawReply.statusCode !== 200 ? rawReply.statusCode : undefined)
                        ?? (rawReply.raw?.statusCode && rawReply.raw.statusCode !== 200 ? rawReply.raw.statusCode : undefined)
                        ?? 500;
                    if (payload instanceof Error || (payload && typeof payload === 'object' && payload.message && errStatusCode >= 400)) {
                        withContext(state.store, () => {
                            try {
                                if (state.store.extra) {
                                    ;
                                    state.store.extra.mechanism = 'fastify.onError';
                                    state.store.extra.handled = true;
                                    state.store.extra.statusCode = errStatusCode;
                                    state.store.extra.getStatusCode = () => errStatusCode;
                                    state.store.extra.fastifyErrorCaptured = true;
                                }
                                attachRequestContextToActiveSpan(state.store);
                                captureError(payload instanceof Error ? payload : new Error(String(payload.message)));
                            }
                            catch (sendErr) {
                                getLogger().error('fastifyPulsePlugin reply.send error capture failed', { error: sendErr });
                            }
                        });
                    }
                }
                return originalSend.apply(this, arguments);
            };
        }
        const runInScope = () => {
            withContext(state.store, () => {
                attachRequestContextToActiveSpan(state.store);
                hookDone();
            });
        };
        if (state.createdServerSpan && state.activeSpan) {
            context.with(trace.setSpan(context.active(), state.activeSpan), runInScope);
        }
        else {
            runInScope();
        }
    });
    fastify.addHook('onResponse', (request, reply, hookDone) => {
        const state = request.pulse;
        if (!state) {
            hookDone();
            return;
        }
        withContext(state.store, () => {
            try {
                const statusCode = reply.statusCode ?? reply.raw?.statusCode ?? 0;
                if (statusCode >= 400 && !state.store.extra?.['fastifyErrorCaptured']) {
                    const defaultMsg = statusCode === 422 ? 'Fastify 422 error' : statusCode === 401 ? 'Fastify 401 error' : `Fastify HTTP ${statusCode} error`;
                    const err = reply?.raw?._error
                        ?? request?.raw?._error
                        ?? new Error(defaultMsg);
                    if (state.store.extra) {
                        ;
                        state.store.extra.mechanism = 'fastify.onError';
                        state.store.extra.handled = true;
                        state.store.extra.statusCode = statusCode;
                        state.store.extra.getStatusCode = () => statusCode;
                        state.store.extra.fastifyErrorCaptured = true;
                    }
                    attachRequestContextToActiveSpan(state.store);
                    captureError(err);
                }
                captureFastifyCompletion(request, reply, state);
            }
            catch (err) {
                getLogger().error('fastifyPulsePlugin completion failed', { error: err });
            }
            hookDone();
        });
    });
    fastify.addHook('preSerialization', (request, reply, payload, hookDone) => {
        const state = request.pulse;
        if (state) {
            const errStatusCode = payload?.statusCode
                ?? (reply.statusCode && reply.statusCode !== 200 ? reply.statusCode : undefined)
                ?? (reply.raw?.statusCode && reply.raw.statusCode !== 200 ? reply.raw.statusCode : undefined)
                ?? 500;
            if (payload instanceof Error || (payload && typeof payload === 'object' && payload.message && errStatusCode >= 400)) {
                withContext(state.store, () => {
                    try {
                        if (state.store.extra) {
                            ;
                            state.store.extra.mechanism = 'fastify.onError';
                            state.store.extra.handled = true;
                            state.store.extra.statusCode = errStatusCode;
                            state.store.extra.getStatusCode = () => errStatusCode;
                        }
                        attachRequestContextToActiveSpan(state.store);
                        captureError(payload instanceof Error ? payload : new Error(String(payload.message)));
                    }
                    catch (err) {
                        getLogger().error('fastifyPulsePlugin preSerialization error capture failed', { error: err });
                    }
                });
            }
        }
        hookDone(null, payload);
    });
    fastify.addHook('onError', (request, reply, error, hookDone) => {
        const state = request.pulse;
        if (!state) {
            if (typeof hookDone === 'function')
                hookDone();
            return;
        }
        const errStatusCode = error?.statusCode
            ?? error?.status
            ?? (reply.statusCode && reply.statusCode !== 200 ? reply.statusCode : undefined)
            ?? (reply.raw?.statusCode && reply.raw.statusCode !== 200 ? reply.raw.statusCode : undefined)
            ?? 500;
        withContext(state.store, () => {
            try {
                if (state.store.extra) {
                    ;
                    state.store.extra.mechanism = 'fastify.onError';
                    state.store.extra.handled = true;
                    state.store.extra.statusCode = errStatusCode;
                    state.store.extra.getStatusCode = () => errStatusCode;
                    state.store.extra.fastifyErrorCaptured = true;
                }
                attachRequestContextToActiveSpan(state.store);
                captureError(error);
                const currentActiveSpan = trace.getActiveSpan() ?? state.activeSpan;
                if (currentActiveSpan) {
                    try {
                        currentActiveSpan.recordException(error);
                        currentActiveSpan.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
                    }
                    catch { /* fail-open */ }
                }
            }
            catch (err) {
                getLogger().error('fastifyPulsePlugin error capture failed', { error: err });
            }
            if (typeof hookDone === 'function')
                hookDone();
        });
    });
    fastify.addHook('onSend', (request, reply, payload, hookDone) => {
        const state = request.pulse;
        if (state && !state.store.extra?.['fastifyErrorCaptured']) {
            let errToCapture = null;
            let statusCode = reply.statusCode ?? reply.raw?.statusCode ?? 200;
            if (payload instanceof Error) {
                errToCapture = payload;
                statusCode = payload.statusCode ?? statusCode;
            }
            else {
                let payloadStr = '';
                if (typeof payload === 'string') {
                    payloadStr = payload;
                }
                else if (Buffer.isBuffer(payload)) {
                    payloadStr = payload.toString('utf8');
                }
                else if (payload && typeof payload === 'object') {
                    const obj = payload;
                    if (typeof obj['statusCode'] === 'number') {
                        statusCode = obj['statusCode'];
                    }
                    if (typeof obj['message'] === 'string' && statusCode >= 400) {
                        errToCapture = new Error(String(obj['message']));
                    }
                }
                if (payloadStr) {
                    try {
                        const parsed = JSON.parse(payloadStr);
                        if (parsed && typeof parsed === 'object') {
                            if (typeof parsed['statusCode'] === 'number') {
                                statusCode = parsed['statusCode'];
                            }
                            if (typeof parsed['message'] === 'string' && statusCode >= 400) {
                                errToCapture = new Error(parsed['message']);
                            }
                        }
                    }
                    catch { }
                }
            }
            if (errToCapture && statusCode >= 400) {
                withContext(state.store, () => {
                    try {
                        if (state.store.extra) {
                            ;
                            state.store.extra.mechanism = 'fastify.onError';
                            state.store.extra.handled = true;
                            state.store.extra.statusCode = statusCode;
                            state.store.extra.getStatusCode = () => statusCode;
                            state.store.extra.fastifyErrorCaptured = true;
                        }
                        attachRequestContextToActiveSpan(state.store);
                        captureError(errToCapture);
                    }
                    catch (err) {
                        getLogger().error('fastifyPulsePlugin onSend error capture failed', { error: err });
                    }
                });
            }
        }
        hookDone(null, payload);
    });
    if (typeof fastify.setErrorHandler === 'function') {
        const defaultErrorHandler = fastify.errorHandler;
        fastify.setErrorHandler(function (error, request, reply) {
            const state = request.pulse;
            if (state) {
                const errStatusCode = error?.statusCode
                    ?? error?.status
                    ?? (reply.statusCode && reply.statusCode !== 200 ? reply.statusCode : undefined)
                    ?? (reply.raw?.statusCode && reply.raw.statusCode !== 200 ? reply.raw.statusCode : undefined)
                    ?? 500;
                withContext(state.store, () => {
                    try {
                        if (state.store.extra) {
                            ;
                            state.store.extra.mechanism = 'fastify.onError';
                            state.store.extra.handled = true;
                            state.store.extra.statusCode = errStatusCode;
                            state.store.extra.getStatusCode = () => errStatusCode;
                            state.store.extra.fastifyErrorCaptured = true;
                        }
                        attachRequestContextToActiveSpan(state.store);
                        captureError(error);
                    }
                    catch (err) {
                        getLogger().error('fastifyPulsePlugin errorHandler error capture failed', { error: err });
                    }
                });
            }
            if (typeof defaultErrorHandler === 'function') {
                return defaultErrorHandler.call(this, error, request, reply);
            }
            if (typeof reply.send === 'function') {
                reply.send(error);
            }
        });
    }
    done();
}
;
fastifyPulsePlugin[Symbol.for('skip-override')] = true;
fastifyPulsePlugin[Symbol.for('fastify.display-name')] = 'pulse-fastify';
function captureFastifyCompletion(request, reply, state) {
    if (state.captured)
        return;
    state.captured = true;
    const statusCode = reply.statusCode ?? reply.raw?.statusCode ?? 0;
    const bodySnapshot = captureBodySnapshot(request.body, state.captureBody);
    const responseSize = readContentLength(reply.getHeader?.('content-length'));
    const currentActiveSpan = trace.getActiveSpan() ?? state.activeSpan;
    if (currentActiveSpan) {
        const route = normalizedRoute(request);
        const enrichmentAttrs = {
            'http.route': route,
            'http.status_code': statusCode,
            'pulse.request_id': state.requestId,
            'pulse.latency_ms': Date.now() - state.startTime,
        };
        if (state.tenantId)
            enrichmentAttrs['pulse.tenant_id'] = state.tenantId;
        if (state.userId)
            enrichmentAttrs['pulse.user_id'] = state.userId;
        if (state.sessionId)
            enrichmentAttrs['pulse.session_id'] = state.sessionId;
        if (state.clientIp)
            enrichmentAttrs['http.client_ip'] = state.clientIp;
        if (state.userAgent)
            enrichmentAttrs['http.user_agent'] = state.userAgent;
        if (state.referer)
            enrichmentAttrs['http.referer'] = state.referer;
        if (bodySnapshot.bodySize !== undefined)
            enrichmentAttrs['http.request.body.size'] = bodySnapshot.bodySize;
        if (responseSize !== undefined)
            enrichmentAttrs['http.response.body.size'] = responseSize;
        currentActiveSpan.setAttributes(enrichmentAttrs);
        if (statusCode >= 500) {
            currentActiveSpan.setStatus({ code: SpanStatusCode.ERROR });
        }
        else if (statusCode >= 100 && statusCode < 400) {
            currentActiveSpan.setStatus({ code: SpanStatusCode.OK });
        }
    }
    if (state.createdServerSpan && state.activeSpan) {
        try {
            state.activeSpan.end();
        }
        catch (endErr) {
            getLogger().error('Failed to end Fastify server span', { error: endErr });
        }
    }
    captureRequest({
        type: 'request',
        requestId: state.requestId,
        method: request.method,
        url: normalizedRoute(request),
        statusCode,
        latency: Date.now() - state.startTime,
        timestamp: Date.now(),
        traceId: getTraceId() ?? state.store.traceId ?? state.activeSpan?.spanContext().traceId,
        spanId: getSpanId() ?? state.store.spanId ?? state.activeSpan?.spanContext().spanId,
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
