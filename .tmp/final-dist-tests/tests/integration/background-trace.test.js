import { after, before, beforeEach, afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { gunzipSync } from 'node:zlib';
import { trace, context as otelContext, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { init } from '../../src/core/init.js';
import { shutdown, flush, flushTracer, monitorMiddleware, withBackgroundSpan, startBackgroundSpan, getActiveBackgroundSpanCount, withSpan, withDbSpan, addBreadcrumb, getRequestContext, } from '../../src/index.js';
import { createContextStore, withContext } from '../../src/core/context.js';
import { getTraceAggregator, resetTraceAggregator } from '../../src/tracing/trace-aggregator.js';
import { drainPendingEventProcessing } from '../../src/core/event-pipeline.js';
import { TEST_REMOTE_CONFIG } from '../fixtures/remote-config.js';
async function startMockBackend() {
    const capturedEvents = [];
    let origin = '';
    const server = http.createServer((req, res) => {
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
                if (body && Array.isArray(body.events)) {
                    capturedEvents.push(...body.events);
                }
                else if (body && body.type) {
                    capturedEvents.push(body);
                }
            }
            catch { }
            if (req.url === '/v1/init') {
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify({
                    success: true,
                    projectId: 'test-project',
                    environment: 'test-env',
                    release: '1.0.0',
                    config: {
                        ...TEST_REMOTE_CONFIG,
                        sdk: {
                            projectId: 'test-project',
                            service: 'test-background-service',
                            environment: 'test-env',
                            release: '1.0.0',
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
                            retry: { ...TEST_REMOTE_CONFIG.transport.retry, enabled: false, maxRetries: 0 },
                            routes: Object.fromEntries(Object.entries(TEST_REMOTE_CONFIG.transport.routes).map(([name, route]) => [
                                name,
                                {
                                    ...route,
                                    url: `${origin}/api/v1/${name}`,
                                    batchSize: 50,
                                    flushIntervalMs: 50,
                                    timeoutMs: 2_000,
                                },
                            ])),
                        },
                    },
                }));
                return;
            }
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ success: true, accepted: true }));
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address();
    origin = `http://127.0.0.1:${addr.port}`;
    return {
        url: origin,
        capturedEvents,
        close: async () => {
            await new Promise(resolve => server.close(() => resolve()));
        },
    };
}
describe('Detached Background Trace Support & Lifecycle Isolation', { concurrency: false }, () => {
    let backend;
    before(async () => {
        backend = await startMockBackend();
        process.env['SDK_BASE_URL'] = backend.url;
        await init({
            apiKey: 'test-background-key',
        });
    });
    after(async () => {
        await shutdown(2000);
        await backend.close();
    });
    beforeEach(() => {
        backend.capturedEvents.length = 0;
    });
    it('coordinates detached background work outliving HTTP response without dropping spans', async () => {
        const app = express();
        app.use(monitorMiddleware());
        let backgroundCompleted = false;
        let httpTraceId = '';
        let httpSpanId = '';
        let backgroundTraceId = '';
        let backgroundSpanId = '';
        app.post('/jobs', (req, res) => {
            const activeSpan = trace.getActiveSpan();
            assert.ok(activeSpan, 'Active HTTP server span must exist inside request handler');
            const sc = activeSpan.spanContext();
            httpTraceId = sc.traceId;
            httpSpanId = sc.spanId;
            // Immediately return 202 Accepted to client — ends HTTP root span promptly
            res.status(202).json({ status: 'queued', jobId: 'job-123' });
            // Spawn detached background work that runs for > 250ms (the HTTP trace safety deadline)
            void withBackgroundSpan('process-queued-job', async (bgSpan) => {
                backgroundTraceId = bgSpan.traceId;
                backgroundSpanId = bgSpan.spanId;
                // Background trace must have its own distinct traceId
                assert.notEqual(backgroundTraceId, httpTraceId, 'Background span must generate a fresh independent traceId');
                // Simulate background execution spanning 350ms (well past the 250ms deadline)
                await new Promise(r => setTimeout(r, 300));
                // Create a child span inside background context
                await withSpan('execute-job-step-1', async () => {
                    await new Promise(r => setTimeout(r, 50));
                });
                backgroundCompleted = true;
            });
        });
        const server = http.createServer(app);
        await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve()));
        const serverAddr = server.address();
        const serverUrl = `http://127.0.0.1:${serverAddr.port}`;
        try {
            const res = await fetch(`${serverUrl}/jobs`, { method: 'POST' });
            assert.equal(res.status, 202);
            const data = await res.json();
            assert.equal(data.status, 'queued');
            // Wait for background job to finish completely
            const timeout = Date.now() + 5000;
            while (!backgroundCompleted && Date.now() < timeout) {
                await new Promise(r => setTimeout(r, 50));
            }
            assert.ok(backgroundCompleted, 'Background work must complete');
            // Flush tracer and pipeline to push all events to mock backend
            await flushTracer();
            await drainPendingEventProcessing();
            await flush();
            // Poll until backend receives both the HTTP trace and the background trace
            const deadline = Date.now() + 5000;
            while (Date.now() < deadline && backend.capturedEvents.filter(e => e.type === 'trace').length < 2) {
                await new Promise(r => setTimeout(r, 100));
                await flushTracer();
                await drainPendingEventProcessing();
                await flush();
            }
            const traces = backend.capturedEvents.filter(e => e.type === 'trace');
            assert.ok(traces.length >= 2, `Expected at least 2 traces, got ${traces.length}`);
            const httpTrace = traces.find(t => t.traceId === httpTraceId);
            assert.ok(httpTrace, 'Originating HTTP trace must be finalized and exported');
            assert.equal(httpTrace.isPartial, false, 'HTTP trace must be complete (not partial)');
            const bgTrace = traces.find(t => t.traceId === backgroundTraceId);
            assert.ok(bgTrace, 'Detached background trace must be finalized and exported');
            assert.equal(bgTrace.isPartial, false, 'Background trace must be complete (not partial)');
            // Verify causal link on background trace root span
            const rootSpan = bgTrace.rootSpan;
            assert.equal(rootSpan.name, 'process-queued-job');
            assert.equal(rootSpan.attributes['pulse.background'], true);
            assert.equal(rootSpan.attributes['pulse.originating.trace_id'], httpTraceId);
            assert.equal(rootSpan.attributes['pulse.originating.span_id'], httpSpanId);
            // Verify OpenTelemetry links
            assert.ok(Array.isArray(rootSpan.links), 'Root span must have links array');
            const causeLink = rootSpan.links.find((l) => l.traceId === httpTraceId);
            assert.ok(causeLink, 'Background span must have a SpanLink to originating HTTP trace');
            assert.equal(causeLink.spanId, httpSpanId);
            assert.equal(causeLink.attributes?.['pulse.link.type'], 'caused_by');
            // Verify child span inside background trace
            assert.ok(Array.isArray(rootSpan.children), 'Background root span must have children array');
            const childStep = rootSpan.children.find((c) => c.name === 'execute-job-step-1');
            assert.ok(childStep, 'Child span created inside background work must belong to the background trace');
            assert.equal(childStep.parentSpanId, backgroundSpanId, 'Child span parent must be the background root span');
        }
        finally {
            await new Promise(resolve => server.close(() => resolve()));
        }
    });
    it('forks context store to provide isolated breadcrumbs without cross-contamination', async () => {
        let capturedOriginatingBreadcrumbs = [];
        let capturedBgBreadcrumbs = [];
        const origStore = createContextStore('req-originating-test', 100);
        await withContext(origStore, async () => {
            await withSpan('originating-request', async (origSpan) => {
                addBreadcrumb({ category: 'http', message: 'Received user request' });
                await withBackgroundSpan('detached-audit-log', async () => {
                    addBreadcrumb({ category: 'audit', message: 'Background audit task written' });
                    const store = getRequestContext();
                    capturedBgBreadcrumbs = store?.breadcrumbs.toArray() ?? [];
                });
                addBreadcrumb({ category: 'http', message: 'Sent response to user' });
                const currentStore = getRequestContext();
                capturedOriginatingBreadcrumbs = currentStore?.breadcrumbs.toArray() ?? [];
            });
        });
        // Verify originating store has only originating breadcrumbs
        const origMessages = capturedOriginatingBreadcrumbs.map(b => b.message);
        assert.ok(origMessages.includes('Received user request'));
        assert.ok(origMessages.includes('Sent response to user'));
        assert.ok(!origMessages.includes('Background audit task written'), 'Originating store must not contain background breadcrumbs');
        // Verify background store has isolated breadcrumbs
        const bgMessages = capturedBgBreadcrumbs.map(b => b.message);
        assert.ok(bgMessages.includes('Background audit task written'), 'Background store must contain background breadcrumbs');
    });
    it('records errors and marks background trace with hasError', async () => {
        let bgTraceId = '';
        await withSpan('originating-caller', async () => {
            await assert.rejects(async () => {
                await withBackgroundSpan('failing-background-task', async (bgSpan) => {
                    bgTraceId = bgSpan.traceId;
                    throw new Error('Database connection reset during background flush');
                });
            }, /Database connection reset during background flush/);
        });
        await flushTracer();
        await drainPendingEventProcessing();
        await flush();
        const traces = backend.capturedEvents.filter(e => e.type === 'trace' && e.traceId === bgTraceId);
        assert.ok(traces.length >= 1, 'Failing background trace must be emitted');
        const traceDoc = traces[0];
        assert.equal(traceDoc.hasError, true, 'Trace must be marked with hasError: true');
        assert.equal(traceDoc.rootSpan.status, 'error');
    });
    it('enforces concurrency bounds and accurately tracks active background span count', async () => {
        const initialCount = getActiveBackgroundSpanCount();
        assert.equal(initialCount, 0, 'Active background span count must initially be 0');
        let inFlightCount = 0;
        let releaseWork = () => { };
        const workPromise = new Promise(resolve => { releaseWork = resolve; });
        const bgPromise = withBackgroundSpan('long-running-bg-task', async () => {
            inFlightCount = getActiveBackgroundSpanCount();
            await workPromise;
        });
        // Give microtask time to start
        await new Promise(r => setTimeout(r, 20));
        assert.equal(inFlightCount, 1, 'Active background count must be 1 while task is running');
        assert.equal(getActiveBackgroundSpanCount(), 1);
        releaseWork();
        await bgPromise;
        assert.equal(getActiveBackgroundSpanCount(), 0, 'Active background count must return to 0 after completion');
    });
    it('enforces timeoutMs safety deadline fail-open without cancelling user work', async () => {
        let userWorkCompleted = false;
        const result = await withBackgroundSpan('timeout-bg-task', { timeoutMs: 50 }, async (span) => {
            // Operation takes 120ms (longer than 50ms deadline)
            await new Promise(r => setTimeout(r, 120));
            userWorkCompleted = true;
            return 'operation-result';
        });
        assert.equal(result, 'operation-result', 'User operation must return result even if timeout triggered (fail-open)');
        assert.ok(userWorkCompleted, 'User work must run to completion uninterrupted');
        await flushTracer();
        await drainPendingEventProcessing();
    });
    it('supports startBackgroundSpan for manual lifecycle management', async () => {
        let parentTraceId = '';
        let parentSpanId = '';
        await withSpan('manual-caller', async (span) => {
            const sc = span.spanContext();
            parentTraceId = sc.traceId;
            parentSpanId = sc.spanId;
            const bgSpan = startBackgroundSpan('manual-worker', {
                attributes: { 'task.queue': 'email-delivery' },
            });
            assert.equal(getActiveBackgroundSpanCount(), 1, 'Manual span increments active count');
            assert.notEqual(bgSpan.traceId, parentTraceId, 'Manual bg span must have distinct traceId');
            bgSpan.setAttribute('worker.batch_size', 50);
            bgSpan.end();
            assert.equal(getActiveBackgroundSpanCount(), 0, 'Manual span.end() decrements active count');
        });
        await flushTracer();
        await drainPendingEventProcessing();
    });
    it('handles background span timeout: ends span after deadline without aborting app work, no duplicate export', async () => {
        let appWorkCompleted = false;
        let bgTraceId = '';
        const result = await withBackgroundSpan('timeout-job-semantics', { timeoutMs: 50 }, async (span) => {
            bgTraceId = span.traceId;
            assert.equal(span.isRecording(), true, 'Span is recording before timeout');
            // Sleep past timeout deadline (120ms > 50ms)
            await new Promise(r => setTimeout(r, 120));
            // Span must now be force-ended
            assert.equal(span.isEnded, true, 'Span must be marked ended after timeout');
            // Application work continues uninterrupted to completion
            appWorkCompleted = true;
            return 'work-completed-successfully';
        });
        assert.equal(result, 'work-completed-successfully', 'Return value passed through fail-open');
        assert.ok(appWorkCompleted, 'User work completed despite timeout');
        await flushTracer();
        await drainPendingEventProcessing();
        await flush();
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline && backend.capturedEvents.filter(e => e.type === 'trace' && e.traceId === bgTraceId).length === 0) {
            await new Promise(r => setTimeout(r, 50));
            await flushTracer();
            await drainPendingEventProcessing();
            await flush();
        }
        const traces = backend.capturedEvents.filter(e => e.type === 'trace' && e.traceId === bgTraceId);
        assert.equal(traces.length, 1, 'Exactly one trace must be exported (no duplicate export, no resurrected trace)');
        assert.equal(traces[0].hasError, true, 'Timed out trace must have hasError: true');
        assert.equal(traces[0].rootSpan.status, 'error');
        const events = traces[0].rootSpan.events ?? [];
        assert.ok(events.some((e) => e.name === 'pulse.span.timeout'), 'Span must have pulse.span.timeout event');
    });
    it('handles timeout race: database child started after timeout does not resurrect trace or create duplicate export', async () => {
        let dbChildCompleted = false;
        let bgTraceId = '';
        await withBackgroundSpan('race-bg-job', { timeoutMs: 40 }, async (span) => {
            bgTraceId = span.traceId;
            // Wait past timeout so root span times out and trace aggregator finalizes
            await new Promise(r => setTimeout(r, 100));
            assert.equal(span.isEnded, true, 'Root span must have timed out and ended');
            // Database child starts AFTER root span has timed out
            await withDbSpan({
                system: 'postgresql',
                operation: 'SELECT',
                table: 'orders',
                statement: 'SELECT * FROM orders WHERE id = $1',
            }, async (dbSpan) => {
                dbChildCompleted = true;
                assert.ok(dbSpan, 'dbSpan object provided to user callback');
            });
        });
        assert.ok(dbChildCompleted, 'Database child work executed to completion');
        await flushTracer();
        await drainPendingEventProcessing();
        await flush();
        await new Promise(r => setTimeout(r, 100));
        await flushTracer();
        await drainPendingEventProcessing();
        await flush();
        const traces = backend.capturedEvents.filter(e => e.type === 'trace' && e.traceId === bgTraceId);
        assert.equal(traces.length, 1, 'Trace must NOT be resurrected; exactly 1 trace document exported');
        assert.equal(traces[0].rootSpan.name, 'race-bg-job');
        assert.equal(traces[0].rootSpan.status, 'error');
    });
    it('enforces 1000 background span limit: degrades #1001 to untraced and correctly recycles counter when 999 finish', async () => {
        const spans = [];
        try {
            // 1. Fill activeBackgroundSpans to exactly 1000
            for (let i = 0; i < 1000; i++) {
                spans.push(startBackgroundSpan(`concurrent-bg-span-${i}`));
            }
            assert.equal(getActiveBackgroundSpanCount(), 1000, 'Count must reach 1000');
            // 2. Operation #1001: test deterministic policy (DEGRADE to untraced NoopSpan)
            let executed1001 = false;
            const result1001 = await withBackgroundSpan('overflow-job', async (span) => {
                executed1001 = true;
                assert.equal(span.isRecording(), false, 'Span #1001 must be non-recording NoopSpan');
                return 'degraded-success';
            });
            assert.equal(executed1001, true, 'Operation #1001 must execute (fail-open, never aborted)');
            assert.equal(result1001, 'degraded-success', 'Operation #1001 returns user result');
            assert.equal(getActiveBackgroundSpanCount(), 1000, 'Counter must not exceed 1000');
            // 3. Test startBackgroundSpan overflow degradation
            const manual1001 = startBackgroundSpan('overflow-manual');
            assert.equal(manual1001.isRecording(), false, 'Manual span #1001 is NoopSpan');
            assert.equal(getActiveBackgroundSpanCount(), 1000, 'Counter remains 1000');
            manual1001.end(); // Ending NoopSpan should not corrupt counter
            assert.equal(getActiveBackgroundSpanCount(), 1000, 'Ending degraded NoopSpan does not decrement counter');
            // 4. Test recycling: 999 finish -> active count becomes 1
            for (let i = 0; i < 999; i++) {
                spans[i].end();
            }
            assert.equal(getActiveBackgroundSpanCount(), 1, 'Active count must be 1 after ending 999 spans');
            // 5. New background span starts -> active count becomes 2, runs TRACED
            let executedNew = false;
            await withBackgroundSpan('recycled-job', async (span) => {
                executedNew = true;
                assert.equal(span.isRecording(), true, 'Recycled job must run TRACED');
                assert.equal(getActiveBackgroundSpanCount(), 2, 'Active count becomes 2');
            });
            assert.ok(executedNew);
            assert.equal(getActiveBackgroundSpanCount(), 1, 'Active count drops back to 1');
            // 6. Finish the last remaining span -> count returns to 0
            spans[999].end();
            assert.equal(getActiveBackgroundSpanCount(), 0, 'Active count returns to 0');
        }
        finally {
            // Safety cleanup
            for (const s of spans) {
                try {
                    s.end();
                }
                catch { }
            }
        }
    });
});
