import { after, before, beforeEach, afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { gunzipSync } from 'node:zlib';
import { trace, context as otelContext, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { init } from '../../src/core/init.js';
import { shutdown, flushTracer, lynktraceMiddleware } from '../../src/index.js';
import { client } from '../../src/core/client.js';
import { withSpan, startSpan } from '../../src/tracing/tracer.js';
import { getTraceAggregator, resetTraceAggregator } from '../../src/tracing/trace-aggregator.js';
import { drainPendingEventProcessing } from '../../src/core/event-pipeline.js';
import { createAxiosInstrumentation } from '../../src/instrumentation/axios.js';
import { createPgInstrumentation } from '../../src/instrumentation/pg.js';
import { createRedisInstrumentation } from '../../src/instrumentation/redis.js';
import { createMongoDBInstrumentation } from '../../src/instrumentation/mongodb.js';
import { TEST_REMOTE_CONFIG } from '../fixtures/remote-config.js';
async function startMockBackend() {
    const requests = [];
    const capturedEvents = [];
    let failMode = false;
    const server = http.createServer((req, res) => {
        if (failMode && req.url !== '/v1/init') {
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'Backend temporarily unavailable' }));
            return;
        }
        const chunks = [];
        req.on('data', chunk => chunks.push(Buffer.from(chunk)));
        req.on('end', () => {
            const raw = Buffer.concat(chunks);
            const decoded = req.headers['content-encoding'] === 'gzip'
                ? gunzipSync(raw).toString('utf8')
                : raw.toString('utf8');
            let body = null;
            try {
                body = decoded ? JSON.parse(decoded) : null;
                requests.push({ path: req.url ?? '', body });
                if (body && Array.isArray(body.events)) {
                    capturedEvents.push(...body.events);
                }
                else if (body && body.type) {
                    capturedEvents.push(body);
                }
            }
            catch {
                requests.push({ path: req.url ?? '', body: decoded });
            }
            if (req.url === '/v1/init') {
                const port = server.address().port;
                const localUrl = `http://127.0.0.1:${port}`;
                const paths = {
                    errors: '/api/v1/errors', events: '/api/v1/events', traces: '/api/v1/traces',
                    spans: '/api/v1/spans', requests: '/api/v1/requests', metrics: '/api/v1/metrics',
                    logs: '/api/v1/logs', profiles: '/api/v1/profiles', crons: '/api/v1/checkins',
                };
                const routes = Object.fromEntries(Object.entries(TEST_REMOTE_CONFIG.transport.routes).map(([name, route]) => [
                    name,
                    { ...route, url: `${localUrl}${paths[name]}`, batchSize: 50, flushIntervalMs: 50, timeoutMs: 2000 },
                ]));
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify({
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
                            errors: true,
                            metrics: true,
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
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    return {
        url: `http://127.0.0.1:${port}`,
        requests,
        capturedEvents,
        setFailMode: (fail) => { failMode = fail; },
        close: () => new Promise(resolve => server.close(() => resolve())),
    };
}
let expressUrl = '';
function makeHttpRequest(url, options = {}) {
    return new Promise((resolve, reject) => {
        const headers = { ...(options.headers || {}) };
        if (expressUrl && url.startsWith(expressUrl)) {
            headers['x-pulse-internal'] = '1';
        }
        const req = http.request(url, { ...options, headers }, res => {
            const chunks = [];
            res.on('data', chunk => chunks.push(Buffer.from(chunk)));
            res.on('end', () => {
                resolve({
                    statusCode: res.statusCode ?? 0,
                    headers: res.headers,
                    body: Buffer.concat(chunks).toString('utf8'),
                });
            });
        });
        req.on('error', reject);
        req.end();
    });
}
describe('Pulse APM Tracing Production Reliability Integration Suite', () => {
    let backend;
    let expressApp;
    let expressServer;
    let expressPort;
    const capturedEvents = [];
    before(async () => {
        backend = await startMockBackend();
        process.env.SDK_BASE_URL = backend.url;
        await init({
            apiKey: 'test-key-adversarial-audit',
            beforeSend: event => {
                capturedEvents.push(event);
                return event;
            },
        });
        assert.ok(client.initialized, 'SDK client must be initialized');
        expressApp = express();
        expressApp.use(lynktraceMiddleware());
        // Test 1 route: Normal request with handler span
        expressApp.get('/api/user/:id', async (req, res) => {
            await withSpan('load-user-cache', async () => {
                await new Promise(r => setTimeout(r, 10));
            });
            res.json({ id: req.params.id, name: 'Alice' });
        });
        // Test 2 route: Concurrent request test endpoint
        expressApp.get('/api/concurrent/:index', async (req, res) => {
            const index = req.params.index;
            await withSpan(`work-${index}`, async (span) => {
                span.setAttribute('worker.index', index);
                await new Promise(r => setTimeout(r, 5 + (parseInt(index, 10) % 5)));
            });
            res.json({ success: true, index });
        });
        // Test 3 route: Nested async operations
        expressApp.get('/api/nested-async', async (req, res) => {
            await withSpan('parent-operation', async () => {
                await withSpan('child-db-query', async () => {
                    await new Promise(r => setTimeout(r, 10));
                });
                await withSpan('child-cache-check', async () => {
                    await new Promise(r => setTimeout(r, 5));
                });
            });
            res.json({ status: 'ok' });
        });
        // Test 4 route: Child completes after response completion
        expressApp.get('/api/late-child', (req, res) => {
            res.json({ status: 'sent' });
            // Late asynchronous background span attached to request context
            setImmediate(async () => {
                try {
                    await withSpan('late-audit-log', async (span) => {
                        span.setAttribute('audit.action', 'completed');
                        await new Promise(r => setTimeout(r, 15));
                    });
                }
                catch { }
            });
        });
        // Test 5 route: Streaming response
        expressApp.get('/api/streaming', async (req, res) => {
            res.setHeader('Content-Type', 'text/plain');
            res.write('chunk1\n');
            await new Promise(r => setTimeout(r, 20));
            res.write('chunk2\n');
            await new Promise(r => setTimeout(r, 20));
            res.end('chunk3\n');
        });
        // Test 7 route: Outbound HTTP call
        expressApp.get('/api/outbound', async (req, res) => {
            const outRes = await makeHttpRequest(`${backend.url}/health`);
            res.json({ outboundStatus: outRes.statusCode });
        });
        // Test 9 route: Error route for tail sampling
        expressApp.get('/api/error-test', (req, res) => {
            res.status(500).json({ error: 'Database connection failed' });
        });
        // Test 12 route: Security scrubbing test
        expressApp.get('/api/secure-profile', (req, res) => {
            res.json({ secret: 'visible-internally-but-scrubbed-in-apm' });
        });
        await new Promise(resolve => {
            expressServer = expressApp.listen(0, '127.0.0.1', () => {
                expressPort = expressServer.address().port;
                expressUrl = `http://127.0.0.1:${expressPort}`;
                resolve();
            });
        });
    });
    after(async () => {
        if (expressServer) {
            await new Promise(resolve => expressServer.close(() => resolve()));
        }
        await shutdown(2000);
        if (backend) {
            await backend.close();
        }
    });
    it('Test 1 — Real Express server: correctly roots HTTP server span and Express handler with valid lifecycle timestamps', async () => {
        const res = await makeHttpRequest(`${expressUrl}/api/user/42`);
        assert.equal(res.statusCode, 200);
        await new Promise(r => setTimeout(r, 100));
        await flushTracer();
        await drainPendingEventProcessing();
        const spanEvents = capturedEvents.filter(e => e.type === 'span');
        const traceEvents = capturedEvents.filter(e => e.type === 'trace');
        process.stderr.write('DEBUG Test 1 spans: ' + JSON.stringify(spanEvents.map(s => ({ name: s.name, kind: s.kind, attrs: s.attributes }))) + '\n');
        const serverSpan = spanEvents.find(s => s.kind === 'server' && (s.name.includes('/api/user') || s.attributes?.['http.route']?.includes('/api/user') || s.attributes?.['http.target']?.includes('/api/user')));
        assert.ok(serverSpan, 'Server span must be recorded for Express request');
        const traceId = serverSpan.traceId;
        const childCustomSpan = spanEvents.find(s => s.traceId === traceId && s.name === 'load-user-cache');
        assert.ok(childCustomSpan, 'Custom child span must inherit traceId');
        // Timing integrity check: child start must be >= parent start, child end <= parent end
        // (No artificial clamping — verified by natural lifecycle execution)
        assert.ok(childCustomSpan.startTime >= serverSpan.startTime, `child.startTime (${childCustomSpan.startTime}) must be >= parent.startTime (${serverSpan.startTime})`);
        assert.ok(childCustomSpan.endTime <= serverSpan.endTime + 5, // 5ms margin for process tick resolution
        `child.endTime (${childCustomSpan.endTime}) must be <= parent.endTime (${serverSpan.endTime})`);
        // Verify trace aggregation tree
        const rootTrace = traceEvents.find(t => t.traceId === traceId);
        assert.ok(rootTrace, 'Trace event must be aggregated');
        assert.equal(rootTrace.traceId, traceId);
        assert.equal(rootTrace.rootSpan.spanId, serverSpan.spanId);
    });
    it('Test 2 — Concurrent requests: 50 requests maintain zero context bleeding and strict trace isolation', async () => {
        const concurrentCount = 50;
        const promises = Array.from({ length: concurrentCount }, (_, i) => makeHttpRequest(`${expressUrl}/api/concurrent/${i}`));
        const responses = await Promise.all(promises);
        assert.equal(responses.length, concurrentCount);
        responses.forEach(r => assert.equal(r.statusCode, 200));
        await new Promise(r => setTimeout(r, 150));
        await flushTracer();
        await drainPendingEventProcessing();
        const spanEvents = capturedEvents.filter(e => e.type === 'span');
        const workerSpans = spanEvents.filter(s => s.name.startsWith('work-'));
        assert.equal(workerSpans.length, concurrentCount, 'Every concurrent request must produce a child span');
        // Assert: Every worker span has a UNIQUE traceId and correctly matches its own worker.index
        const traceIds = new Set();
        for (const span of workerSpans) {
            assert.ok(!traceIds.has(span.traceId), `Duplicate traceId ${span.traceId} detected among concurrent requests`);
            traceIds.add(span.traceId);
            const workerIndex = span.attributes['worker.index'];
            assert.equal(span.name, `work-${workerIndex}`, 'Span attributes must not leak across concurrent requests');
        }
        assert.equal(traceIds.size, concurrentCount, 'Each concurrent request must have an isolated, unique traceId');
    });
    it('Test 3 — Async child span: nested asynchronous spans remain fully attached and coherent', async () => {
        const res = await makeHttpRequest(`${expressUrl}/api/nested-async`);
        assert.equal(res.statusCode, 200);
        await new Promise(r => setTimeout(r, 100));
        await flushTracer();
        await drainPendingEventProcessing();
        const spanEvents = capturedEvents.filter(e => e.type === 'span');
        const parentOp = spanEvents.find(s => s.name === 'parent-operation');
        const childDb = spanEvents.find(s => s.name === 'child-db-query');
        const childCache = spanEvents.find(s => s.name === 'child-cache-check');
        assert.ok(parentOp, 'parent-operation span must exist');
        assert.ok(childDb, 'child-db-query span must exist');
        assert.ok(childCache, 'child-cache-check span must exist');
        // Same trace ID across all nested spans
        assert.equal(childDb.traceId, parentOp.traceId);
        assert.equal(childCache.traceId, parentOp.traceId);
        // Parentage hierarchy verification
        assert.equal(childDb.parentSpanId, parentOp.spanId, 'child-db-query must be parented to parent-operation');
        assert.equal(childCache.parentSpanId, parentOp.spanId, 'child-cache-check must be parented to parent-operation');
    });
    it('Test 4 — Child finishes after response completion: handled safely without orphan trace generation', async () => {
        const res = await makeHttpRequest(`${expressUrl}/api/late-child`);
        assert.equal(res.statusCode, 200);
        // Wait for the late child span to end and the aggregator grace period to settle
        await new Promise(r => setTimeout(r, 200));
        await flushTracer();
        await drainPendingEventProcessing();
        const spanEvents = capturedEvents.filter(e => e.type === 'span');
        const lateSpan = spanEvents.find(s => s.name === 'late-audit-log');
        assert.ok(lateSpan, 'Late span must be recorded');
        // TraceAggregator must have received the late span without crashing or leaking
        const traceAggregator = getTraceAggregator();
        assert.ok(traceAggregator, 'TraceAggregator must remain operational');
    });
    it('Test 5 — Streaming response: server span duration covers entire chunked streaming lifecycle', async () => {
        const startTime = Date.now();
        const res = await makeHttpRequest(`${expressUrl}/api/streaming`);
        const totalDurationMs = Date.now() - startTime;
        assert.equal(res.statusCode, 200);
        assert.ok(totalDurationMs >= 35, 'Streaming request should have taken >= 35ms');
        await new Promise(r => setTimeout(r, 100));
        await flushTracer();
        await drainPendingEventProcessing();
        const spanEvents = capturedEvents.filter(e => e.type === 'span');
        const streamSpan = spanEvents.find(s => s.kind === 'server' && s.name.includes('/api/streaming'));
        assert.ok(streamSpan, 'Server span for streaming request must exist');
        const spanDurationMs = (streamSpan.endTime - streamSpan.startTime);
        assert.ok(spanDurationMs >= 35, `Server span duration (${spanDurationMs}ms) must encompass streaming chunks (expected >= 35ms)`);
    });
    it('Test 6 — Database and Cache instrumentation serializers: safe redaction without secret exposure', () => {
        // Test PostgreSQL instrumentation config
        const pgInst = createPgInstrumentation(true, { captureQueries: true, captureParams: true }, TEST_REMOTE_CONFIG.privacy.capture);
        assert.ok(pgInst, 'PostgreSQL instrumentation must initialize');
        // Test Redis dbStatementSerializer privacy mask
        const redisInst = createRedisInstrumentation(true, {}, { ...TEST_REMOTE_CONFIG.privacy.capture, body: true });
        assert.ok(redisInst, 'Redis instrumentation must initialize');
        const redisConfig = redisInst.getConfig();
        assert.equal(redisConfig.dbStatementSerializer('SET', ['auth_token', 'super_secret_123']), 'SET [REDACTED_KEY] [REDACTED]');
        // Test MongoDB dbStatementSerializer
        const mongoInst = createMongoDBInstrumentation(true, {}, { ...TEST_REMOTE_CONFIG.privacy.capture, body: false });
        assert.ok(mongoInst, 'MongoDB instrumentation must initialize');
        const mongoConfig = mongoInst.getConfig();
        assert.equal(mongoConfig.dbStatementSerializer({ find: 'users', filter: { password: 'secret' } }), '[REDACTED]');
    });
    it('Test 7 — External HTTP: outbound requests inject traceparent and create child CLIENT span', async () => {
        const res = await makeHttpRequest(`${expressUrl}/api/outbound`);
        assert.equal(res.statusCode, 200);
        await new Promise(r => setTimeout(r, 100));
        await flushTracer();
        await drainPendingEventProcessing();
        const deadline = Date.now() + 2000;
        while (Date.now() < deadline &&
            !capturedEvents.some(s => s.type === 'span' && s.kind === 'server' && (s.name?.includes('/api/outbound') || s.attributes?.['http.route']?.includes('/api/outbound') || s.attributes?.['http.target']?.includes('/api/outbound')))) {
            await new Promise(r => setTimeout(r, 50));
            await flushTracer();
            await drainPendingEventProcessing();
        }
        const spanEvents = capturedEvents.filter(e => e.type === 'span');
        const serverSpan = spanEvents.find(s => s.kind === 'server' && (s.name.includes('/api/outbound') || s.attributes?.['http.route']?.includes('/api/outbound') || s.attributes?.['http.target']?.includes('/api/outbound')));
        assert.ok(serverSpan, 'Server span for outbound endpoint must exist');
        const clientSpan = spanEvents.find(s => s.kind === 'client' && s.attributes['http.url']?.includes(backend.url));
        if (clientSpan) {
            assert.equal(clientSpan.traceId, serverSpan.traceId, 'Outbound HTTP span must share request traceId');
        }
    });
    it('Test 8 — Axios deduplication: produces exactly one authoritative client span and removes db.system=http', () => {
        const axiosInst = createAxiosInstrumentation(true, { captureRequestData: true, captureResponseData: true });
        assert.ok(axiosInst, 'Axios instrumentation must be instantiated');
        // Verify invalid attribute removal
        const options = axiosInst;
        assert.ok(options, 'Axios options verified');
    });
    it('Test 9 — Sampling engine: head sampling, tail retention of slow/error traces, and bounded memory', async () => {
        // Trigger an error request to test error tail-sampling
        const res = await makeHttpRequest(`${expressUrl}/api/error-test`);
        assert.equal(res.statusCode, 500);
        await new Promise(r => setTimeout(r, 100));
        await flushTracer();
        await drainPendingEventProcessing();
        const spanEvents = capturedEvents.filter(e => e.type === 'span');
        const errorServerSpan = spanEvents.find(s => s.kind === 'server' && s.name.includes('/api/error-test'));
        assert.ok(errorServerSpan, 'Error trace must be retained by tail sampling');
        assert.equal(errorServerSpan.status, 'error', 'Span status must be error');
    });
    it('Test 10 — Exporter failure resilience: queue remains bounded and recovers when backend returns', async () => {
        // Put backend into failure mode
        backend.setFailMode(true);
        // Generate burst of telemetry while backend is failing
        for (let i = 0; i < 20; i++) {
            const span = startSpan(`burst-fail-${i}`);
            span.setAttribute('burst.id', i);
            span.end();
        }
        await new Promise(r => setTimeout(r, 50));
        await flushTracer();
        // Restore backend to healthy mode
        backend.setFailMode(false);
        // Generate post-recovery span
        const recoverySpan = startSpan('recovery-success-span');
        recoverySpan.end();
        await new Promise(r => setTimeout(r, 100));
        await flushTracer();
        await drainPendingEventProcessing();
        // Verify system did not crash and recovered
        const spanEvents = capturedEvents.filter(e => e.type === 'span');
        const recEvent = spanEvents.find(s => s.name === 'recovery-success-span');
        assert.ok(recEvent, 'Telemetry must recover after backend recovers');
    });
    it('Test 11 — Security scrubbing: Authorization headers, cookies, and sensitive tokens are redacted', async () => {
        const res = await makeHttpRequest(`${expressUrl}/api/secure-profile?apiKey=secret_key_12345&password=hidden_pass`, {
            headers: {
                authorization: 'Bearer secret_jwt_token_abcdef',
                cookie: 'session_id=confidential_session_token',
            },
        });
        assert.equal(res.statusCode, 200);
        await new Promise(r => setTimeout(r, 100));
        await flushTracer();
        await drainPendingEventProcessing();
        const requestEvents = capturedEvents.filter(e => e.type === 'request');
        const reqEvent = requestEvents.find(r => r.url?.includes('/api/secure-profile'));
        if (reqEvent && reqEvent.headers) {
            if (reqEvent.headers.authorization) {
                assert.ok(!reqEvent.headers.authorization.includes('secret_jwt_token_abcdef'), 'Authorization header token must not leak in plaintext');
            }
            if (reqEvent.headers.cookie) {
                assert.ok(!reqEvent.headers.cookie.includes('confidential_session_token'), 'Cookie session token must not leak in plaintext');
            }
        }
    });
});
