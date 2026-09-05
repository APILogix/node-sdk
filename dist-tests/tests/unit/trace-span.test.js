import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { init, shutdown, startSpan } from '../../src/index.js';
/**
 * Verifies that child spans inherit the same traceId as the root span.
 *
 * The SDK exposes individual named exports (no `Pulse` namespace), so we
 * import `init`, `shutdown`, and `startSpan` directly.
 */
describe('Pulse SDK Trace/Span Consistency', () => {
    afterEach(async () => {
        // Ensure SDK is shut down after each test to avoid side-effects.
        await shutdown();
    });
    it('root and child spans share traceId', async () => {
        // Initialize the SDK against a non-routable host so init never tries
        // to reach a real backend; the offline-fallback config kicks in.
        await init({
            apiKey: 'test-key',
        });
        const rootSpan = startSpan('root');
        const rootTraceId = rootSpan.spanContext().traceId;
        const childSpan = startSpan('child');
        const childTraceId = childSpan.spanContext().traceId;
        assert.strictEqual(childTraceId, rootTraceId, 'Child span traceId differs from root');
        childSpan.end();
        rootSpan.end();
    });
    it('monitorMiddleware extracts incoming W3C traceparent into server span and child spans', async () => {
        const { monitorMiddleware } = await import('../../src/instrumentation/express.js');
        const { trace } = await import('@opentelemetry/api');
        const { TEST_REMOTE_CONFIG } = await import('../fixtures/remote-config.js');
        const origFetch = globalThis.fetch;
        globalThis.fetch = (async (url) => {
            const u = String(url);
            if (u.includes('/v1/init')) {
                return new Response(JSON.stringify({
                    success: true,
                    projectId: 'test-project',
                    environment: 'test',
                    release: '1.0.0',
                    config: {
                        ...TEST_REMOTE_CONFIG,
                        features: {
                            ...TEST_REMOTE_CONFIG.features,
                            tracing: true,
                            requestCapture: true,
                        },
                        sampling: {
                            ...TEST_REMOTE_CONFIG.sampling,
                            traces: 1,
                            requests: 1,
                        },
                    },
                }), { status: 200, headers: { 'content-type': 'application/json' } });
            }
            return new Response('{}', { status: 200 });
        });
        try {
            await init({
                apiKey: 'test-key',
            });
        }
        finally {
            globalThis.fetch = origFetch;
        }
        const incomingTraceId = '4bf92f3577b34da6a3ce929d0e0e4736';
        const incomingParentSpanId = '00f067aa0ba902b7';
        const traceparent = `00-${incomingTraceId}-${incomingParentSpanId}-01`;
        const req = {
            method: 'GET',
            url: '/test-route',
            path: '/test-route',
            headers: {
                traceparent,
            },
        };
        const listeners = {};
        const res = {
            statusCode: 200,
            getHeader: () => undefined,
            once: (event, cb) => {
                listeners[event] = cb;
            },
            on: () => res,
            emit: () => true,
        };
        let capturedTraceId;
        let childTraceId;
        const middleware = monitorMiddleware();
        await new Promise((resolve) => {
            middleware(req, res, () => {
                const activeSpan = trace.getActiveSpan();
                capturedTraceId = activeSpan?.spanContext().traceId;
                const child = startSpan('db.query');
                childTraceId = child.spanContext().traceId;
                child.end();
                resolve();
            });
        });
        assert.strictEqual(capturedTraceId, incomingTraceId, 'Server span should inherit incoming traceparent traceId');
        assert.strictEqual(childTraceId, incomingTraceId, 'Child span should inherit incoming traceparent traceId');
        if (listeners['finish'])
            listeners['finish']();
    });
});
