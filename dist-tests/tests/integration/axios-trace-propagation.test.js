import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { gunzipSync } from 'node:zlib';
import axios from 'axios';
import { trace, context as otelContext } from '@opentelemetry/api';
import { init } from '../../src/core/init.js';
import { shutdown, flushTracer } from '../../src/index.js';
import { withSpan } from '../../src/tracing/tracer.js';
import { drainPendingEventProcessing } from '../../src/core/event-pipeline.js';
import { TEST_REMOTE_CONFIG } from '../fixtures/remote-config.js';
describe('P0.1: Axios W3C Trace Context Propagation & Single Client Span', { concurrency: false }, () => {
    let backendServer;
    let targetServer;
    let backendUrl;
    let targetUrl;
    const receivedTargetRequests = [];
    const capturedBackendEvents = [];
    before(async () => {
        // 1. Target server that receives axios calls
        targetServer = http.createServer((req, res) => {
            receivedTargetRequests.push({
                path: req.url || '/',
                headers: { ...req.headers },
            });
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
        });
        await new Promise(resolve => targetServer.listen(0, '127.0.0.1', () => resolve()));
        const targetAddr = targetServer.address();
        targetUrl = `http://127.0.0.1:${targetAddr.port}`;
        // 2. Mock Pulse backend server
        backendServer = http.createServer((req, res) => {
            if (req.url === '/v1/init') {
                const paths = {
                    errors: '/api/v1/errors', events: '/api/v1/events', traces: '/api/v1/traces',
                    spans: '/api/v1/spans', requests: '/api/v1/requests', metrics: '/api/v1/metrics',
                    logs: '/api/v1/logs', profiles: '/api/v1/profiles', crons: '/api/v1/checkins',
                };
                const routes = Object.fromEntries(Object.entries(TEST_REMOTE_CONFIG.transport.routes).map(([name, route]) => [
                    name,
                    { ...route, url: `${backendUrl}${paths[name]}`, batchSize: 50, flushIntervalMs: 50, timeoutMs: 2000 },
                ]));
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify({
                    success: true,
                    projectId: 'test-project',
                    environment: 'test',
                    release: '1.0.0',
                    config: {
                        ...TEST_REMOTE_CONFIG,
                        instrumentation: {
                            ...TEST_REMOTE_CONFIG.instrumentation,
                            http: true,
                            https: true,
                            fetch: true,
                            axios: true,
                        },
                        features: {
                            ...TEST_REMOTE_CONFIG.features,
                            tracing: true,
                            requestCapture: true,
                        },
                        sampling: {
                            ...TEST_REMOTE_CONFIG.sampling,
                            traces: 1,
                            spans: 1,
                            requests: 1,
                        },
                        transport: {
                            ...TEST_REMOTE_CONFIG.transport,
                            routes,
                        },
                    },
                }));
                return;
            }
            const chunks = [];
            req.on('data', c => chunks.push(Buffer.from(c)));
            req.on('end', () => {
                const raw = Buffer.concat(chunks);
                const decoded = req.headers['content-encoding'] === 'gzip'
                    ? gunzipSync(raw).toString('utf8')
                    : raw.toString('utf8');
                try {
                    const body = JSON.parse(decoded);
                    if (Array.isArray(body.events)) {
                        capturedBackendEvents.push(...body.events);
                    }
                    else if (body.type) {
                        capturedBackendEvents.push(body);
                    }
                }
                catch { }
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ success: true }));
            });
        });
        await new Promise(resolve => backendServer.listen(0, '127.0.0.1', () => resolve()));
        const backendAddr = backendServer.address();
        backendUrl = `http://127.0.0.1:${backendAddr.port}`;
        process.env['SDK_BASE_URL'] = backendUrl;
        await init({
            apiKey: 'test-axios-key',
            beforeSend: event => {
                capturedBackendEvents.push(event);
                return event;
            },
        });
    });
    after(async () => {
        await shutdown(2000);
        await new Promise(resolve => targetServer.close(() => resolve()));
        await new Promise(resolve => backendServer.close(() => resolve()));
    });
    beforeEach(() => {
        receivedTargetRequests.length = 0;
        capturedBackendEvents.length = 0;
    });
    it('injects valid W3C traceparent into outbound Axios request and preserves trace context', async () => {
        let parentTraceId = '';
        let parentSpanId = '';
        await withSpan('parent-operation', async (span) => {
            const ctx = span.spanContext();
            parentTraceId = ctx.traceId;
            parentSpanId = ctx.spanId;
            const res = await axios.get(`${targetUrl}/test-endpoint`, {
                headers: {
                    'x-custom-user-header': 'client-value-123',
                },
            });
            assert.equal(res.status, 200);
            assert.deepEqual(res.data, { ok: true });
        });
        const received = receivedTargetRequests.find(r => r.path === '/test-endpoint');
        assert.ok(received, 'Target server should have received /test-endpoint request');
        // Assert traceparent header exists
        const traceparent = received.headers['traceparent'];
        assert.ok(traceparent, 'traceparent header must be present on outbound Axios request');
        // Format: 00-{traceId}-{spanId}-{flags}
        const parts = traceparent.split('-');
        assert.equal(parts.length, 4, 'traceparent must have 4 hyphen-separated parts');
        assert.equal(parts[0], '00', 'traceparent version must be 00');
        assert.equal(parts[1], parentTraceId, 'traceparent traceId must match parent trace ID');
        assert.notEqual(parts[2], parentSpanId, 'traceparent spanId must be the client span ID, not the parent span ID');
        assert.match(parts[3], /^[0-9a-f]{2}$/, 'traceparent flags must be 2 hex characters');
        // Assert custom header was preserved
        assert.equal(received.headers['x-custom-user-header'], 'client-value-123', 'User headers must be preserved');
    });
    it('preserves an explicitly supplied valid traceparent without overwriting it', async () => {
        const explicitTraceparent = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
        await withSpan('parent-override-operation', async () => {
            const res = await axios.get(`${targetUrl}/explicit-traceparent`, {
                headers: {
                    traceparent: explicitTraceparent,
                },
            });
            assert.equal(res.status, 200);
        });
        const received = receivedTargetRequests.find(r => r.path === '/explicit-traceparent');
        assert.ok(received, 'Target server should have received /explicit-traceparent request');
        assert.equal(received.headers['traceparent'], explicitTraceparent, 'Explicitly supplied traceparent must be preserved');
    });
    it('emits exactly ONE authoritative client span per Axios request (no duplicate HTTP/undici spans)', async () => {
        capturedBackendEvents.length = 0;
        await withSpan('single-client-span-parent', async () => {
            const res = await axios.get(`${targetUrl}/dedup-check`);
            assert.equal(res.status, 200);
        });
        await flushTracer();
        await drainPendingEventProcessing();
        // Inspect emitted spans from beforeSend pipeline
        const clientSpans = capturedBackendEvents.filter(e => e.type === 'span' && (e.attributes?.['http.url']?.includes('/dedup-check') || e.attributes?.['http.target']?.includes('/dedup-check')));
        // Verify exactly one client span was emitted for this request
        assert.equal(clientSpans.length, 1, `Expected exactly 1 client span for Axios request, found ${clientSpans.length}: ${JSON.stringify(clientSpans.map(s => s.name))}`);
        const span = clientSpans[0];
        assert.equal(span.attributes['http.user_agent'], 'axios', 'The client span must be authoritative Axios span');
        assert.equal(span.attributes['http.status_code'], 200);
    });
    it('propagates distinct trace context across 5 concurrent Axios requests without cross-contamination', async () => {
        receivedTargetRequests.length = 0;
        const tasks = Array.from({ length: 5 }, (_, i) => withSpan(`concurrent-parent-${i}`, async (span) => {
            const traceId = span.spanContext().traceId;
            const res = await axios.get(`${targetUrl}/concurrent-${i}`, {
                headers: { 'x-expected-trace-id': traceId },
            });
            assert.equal(res.status, 200);
            return traceId;
        }));
        const expectedTraceIds = await Promise.all(tasks);
        assert.equal(receivedTargetRequests.length, 5);
        // Check each request received the exact trace ID matching its concurrent scope
        for (const req of receivedTargetRequests) {
            const expectedTraceId = req.headers['x-expected-trace-id'];
            const traceparent = req.headers['traceparent'];
            assert.ok(traceparent, 'Each concurrent request must have traceparent');
            const actualTraceId = traceparent.split('-')[1];
            assert.equal(actualTraceId, expectedTraceId, `Context leak detected! Expected trace ${expectedTraceId}, received ${actualTraceId}`);
        }
    });
});
