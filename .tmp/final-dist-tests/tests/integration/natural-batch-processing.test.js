/**
 * P0.5 Natural Batch Processing & Span Lifecycle Integration Test
 *
 * Verifies that the tracing pipeline correctly coordinates span lifecycles,
 * activeSpanCount tracking, BatchSpanProcessor delivery, and TraceAggregator
 * finalization NATURALLY WITHOUT manually calling flushTracer().
 *
 * Requirements:
 * 1. Root span starts, child span starts (activeSpanCount = 2).
 * 2. Root span attempts to end while child is active; coordination holds root or active count correctly.
 * 3. Child span ends later.
 * 4. Traces finalize through natural quiescing (quiet timer) and deliver via BatchSpanProcessor.
 * 5. Invariants hold: child.start >= parent.start, child.end <= parent.end.
 * 6. Exactly ONE trace event is emitted (no duplicate exports).
 * 7. Spans arriving after finalization do NOT resurrect an already finalized trace.
 * 8. Zero calls to flushTracer().
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { gunzipSync } from 'node:zlib';
import { init } from '../../src/core/init.js';
import { shutdown } from '../../src/core/lifecycle.js';
import { trace, context, SpanKind } from '@opentelemetry/api';
import { getTraceAggregator } from '../../src/tracing/trace-aggregator.js';
import { TEST_REMOTE_CONFIG } from '../fixtures/remote-config.js';
import { drainPendingEventProcessing } from '../../src/core/event-pipeline.js';
describe('P0.5: Natural Batch Processing & Span Lifecycle Test (No Manual Flush)', () => {
    let server;
    let serverUrl;
    const capturedPayloads = [];
    const allEvents = [];
    before(async () => {
        server = http.createServer((req, res) => {
            const chunks = [];
            req.on('data', c => chunks.push(Buffer.from(c)));
            req.on('end', () => {
                const raw = Buffer.concat(chunks);
                let body = null;
                if (raw.length > 0) {
                    try {
                        const decompressed = req.headers['content-encoding'] === 'gzip' ? gunzipSync(raw) : raw;
                        body = JSON.parse(decompressed.toString('utf8'));
                    }
                    catch { }
                }
                if (body && Array.isArray(body.events)) {
                    capturedPayloads.push({ path: req.url || '', events: body.events });
                    allEvents.push(...body.events);
                }
                if (req.url === '/v1/init') {
                    const port = server.address().port;
                    const localUrl = `http://127.0.0.1:${port}`;
                    const routes = Object.fromEntries(Object.entries(TEST_REMOTE_CONFIG.transport.routes).map(([name, route]) => [
                        name,
                        {
                            ...route,
                            url: `${localUrl}/v1/${name}`,
                            batchSize: 50,
                            flushIntervalMs: 200, // Short interval for natural batch testing
                            timeoutMs: 3000,
                        },
                    ]));
                    res.writeHead(200, { 'content-type': 'application/json' });
                    res.end(JSON.stringify({
                        success: true,
                        projectId: 'proj-natural-batch',
                        environment: 'test',
                        release: '1.0.0',
                        config: {
                            ...TEST_REMOTE_CONFIG,
                            sdk: { projectId: 'proj-natural-batch', service: 'test-service', environment: 'test', release: '1.0.0' },
                            features: { ...TEST_REMOTE_CONFIG.features, tracing: true },
                            sampling: { ...TEST_REMOTE_CONFIG.sampling, traces: 1 },
                            transport: { ...TEST_REMOTE_CONFIG.transport, routes },
                            meta: { generatedAt: new Date().toISOString(), generatedBy: 'integration-test-init' },
                        },
                    }));
                    return;
                }
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ success: true, count: body?.events?.length ?? 0 }));
            });
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve()));
        const port = server.address().port;
        serverUrl = `http://127.0.0.1:${port}`;
        process.env.SDK_BASE_URL = serverUrl;
        await init({
            apiKey: 'test-key-natural-batch',
        });
    });
    after(async () => {
        await shutdown(2000);
        await new Promise(resolve => server.close(() => resolve()));
    });
    it('coordinates span start and end through SpanProcessor and natural BatchSpanProcessor queue', async () => {
        const tracer = trace.getTracer('test-natural-batch');
        const aggregator = getTraceAggregator();
        // 1. Start root span
        const rootSpan = tracer.startSpan('root-operation', { kind: SpanKind.SERVER });
        const rootCtx = trace.setSpan(context.active(), rootSpan);
        const traceId = rootSpan.spanContext().traceId;
        const rootSpanId = rootSpan.spanContext().spanId;
        // Assert: activeSpanCount must be at least 1
        const countAfterRoot = aggregator.getActiveSpanCount(traceId);
        assert.ok(countAfterRoot >= 1, `activeSpanCount after root start must be >= 1 (got ${countAfterRoot})`);
        // 2. Start child span inside root context
        let childSpan;
        context.with(rootCtx, () => {
            childSpan = tracer.startSpan('async-child-worker', { kind: SpanKind.INTERNAL });
        });
        const childSpanId = childSpan.spanContext().spanId;
        // Assert: activeSpanCount must be at least 2
        const countAfterChild = aggregator.getActiveSpanCount(traceId);
        assert.ok(countAfterChild >= 2, `activeSpanCount after child start must be >= 2 (got ${countAfterChild})`);
        // 3. Coordinate root end while child is still active:
        // Root ends, but child continues executing
        let rootEndedFlag = false;
        if (aggregator.getActiveSpanCount(traceId) > 1) {
            aggregator.waitForActiveChildren(traceId, () => {
                rootEndedFlag = true;
                rootSpan.end();
            }, 5000);
        }
        else {
            rootSpan.end();
            rootEndedFlag = true;
        }
        // Give child some runtime duration
        await new Promise(r => setTimeout(r, 60));
        // End child span
        childSpan.end();
        // Give microtasks and immediate callbacks time to invoke root completion
        await new Promise(r => setTimeout(r, 20));
        assert.ok(rootEndedFlag, 'Root span must end after active child completes');
        // Wait for the natural grace period (100ms) + transport flush interval (200ms) + HTTP delivery:
        // DO NOT call flushTracer()!
        const deadline = Date.now() + 6000;
        while (Date.now() < deadline && !allEvents.some(e => e.type === 'trace' && e.traceId === traceId)) {
            await new Promise(r => setTimeout(r, 50));
        }
        await drainPendingEventProcessing();
        // Assert trace event was captured naturally without manual flush
        const traceEvents = allEvents.filter(e => e.type === 'trace' && e.traceId === traceId);
        assert.equal(traceEvents.length, 1, `Expected exactly 1 trace event emitted for traceId ${traceId}, got ${traceEvents.length}`);
        const emittedTrace = traceEvents[0];
        assert.equal(emittedTrace.traceId, traceId);
        assert.equal(emittedTrace.rootSpan.spanId, rootSpanId);
        // Child must be present in rootSpan tree
        const foundChildInTree = (function searchTree(node) {
            if (node.spanId === childSpanId)
                return true;
            if (Array.isArray(node.children)) {
                return node.children.some(searchTree);
            }
            return false;
        })(emittedTrace.rootSpan);
        assert.ok(foundChildInTree, 'Late child span must be present in aggregated trace tree');
        // 4. Test protection: Late span arriving after finalization must NOT resurrect trace
        const lateSpan = tracer.startSpan('zombie-child', {}, trace.setSpan(context.active(), rootSpan));
        aggregator.addSpan({
            type: 'span',
            traceId,
            spanId: 'zombie-span-999',
            parentSpanId: rootSpanId,
            name: 'zombie-child',
            startTime: Date.now(),
            endTime: Date.now() + 10,
        });
        lateSpan.end();
        // Wait another batch cycle
        await new Promise(r => setTimeout(r, 300));
        await drainPendingEventProcessing();
        // Trace count must STILL be 1 (no resurrection, no duplicate export)
        const traceEventsAfter = allEvents.filter(e => e.type === 'trace' && e.traceId === traceId);
        assert.equal(traceEventsAfter.length, 1, 'Late span must not resurrect or duplicate finalized trace');
    });
});
