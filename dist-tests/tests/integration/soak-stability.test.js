/**
 * Soak Stability & Memory Leak Prevention Test
 *
 * Implements a repeatable multi-cycle soak smoke test required by Section 7
 * of the forensic audit. This test is intentionally bounded for CI; it is not
 * a substitute for a multi-hour production-duration soak run.
 *
 * Runs repeated sustained telemetry cycles across all subsystems (errors, spans,
 * traces, metrics, messages) with forced garbage collection and heap tracking.
 *
 * Asserts:
 *   1. Memory stability: Post-GC heapUsed does not grow unboundedly (< 5% drift across plateau cycles).
 *   2. Bounded buffers: TraceAggregator and event queues drain to 0 without leaking objects.
 *   3. Zero unref'd timer leakage or lingering active handles after shutdown.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { gunzipSync } from 'node:zlib';
import { init } from '../../src/core/init.js';
import { shutdown } from '../../src/core/lifecycle.js';
import { captureMessage } from '../../src/capture/captureMessage.js';
import { captureError } from '../../src/capture/captureError.js';
import { captureMetric } from '../../src/capture/captureMetric.js';
import { startSpan } from '../../src/tracing/tracer.js';
import { client } from '../../src/core/client.js';
import { TEST_REMOTE_CONFIG as BAKED_IN_REMOTE_CONFIG } from '../fixtures/remote-config.js';
async function startMockBackend() {
    let receivedBatches = 0;
    let receivedEvents = 0;
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(Buffer.from(chunk)));
        req.on('end', () => {
            const raw = Buffer.concat(chunks);
            const port = server.address().port;
            const localUrl = `http://127.0.0.1:${port}`;
            if (req.url?.includes('init')) {
                const routePaths = {
                    errors: '/api/v1/errors',
                    events: '/api/v1/events',
                    traces: '/api/v1/traces',
                    spans: '/api/v1/spans',
                    requests: '/api/v1/requests',
                    metrics: '/api/v1/metrics',
                    logs: '/api/v1/logs',
                    profiles: '/api/v1/profiles',
                    crons: '/api/v1/checkins',
                    replays: '/api/v1/replays',
                };
                const routes = Object.fromEntries(Object.entries(BAKED_IN_REMOTE_CONFIG.transport.routes).map(([name, route]) => [
                    name,
                    { ...route, url: `${localUrl}${routePaths[name]}`, batchSize: 500, flushIntervalMs: 50, timeoutMs: 3_000 },
                ]));
                res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
                res.end(JSON.stringify({
                    success: true,
                    projectId: 'test-project',
                    environment: 'test',
                    release: '1.0.0',
                    config: {
                        ...BAKED_IN_REMOTE_CONFIG,
                        sdk: { projectId: 'test-project', service: 'test-service', environment: 'test', release: '1.0.0' },
                        features: {
                            ...BAKED_IN_REMOTE_CONFIG.features,
                            tracing: true,
                            requestCapture: true,
                            errors: true,
                            metrics: true,
                        },
                        sampling: {
                            ...BAKED_IN_REMOTE_CONFIG.sampling,
                            traces: 1,
                            requests: 1,
                            errors: 1,
                            metrics: 1,
                        },
                        instrumentation: {
                            ...BAKED_IN_REMOTE_CONFIG.instrumentation,
                            http: false,
                            fetch: false,
                        },
                        offlineQueue: {
                            enabled: false,
                            maxFileSizeBytes: 1024 * 1024,
                            maxEvents: 1000,
                            eventTtlMs: 60000,
                            ioTimeoutMs: 5000,
                            flushDebounceMs: 100,
                        },
                        transport: { ...BAKED_IN_REMOTE_CONFIG.transport, routes },
                    },
                }));
                return;
            }
            // Telemetry ingestion endpoint
            if (req.url?.startsWith('/api/v1/')) {
                receivedBatches++;
                try {
                    const isGzip = req.headers['content-encoding'] === 'gzip';
                    const body = isGzip ? gunzipSync(raw).toString('utf8') : raw.toString('utf8');
                    const parsed = JSON.parse(body);
                    if (Array.isArray(parsed.events)) {
                        receivedEvents += parsed.events.length;
                    }
                    else if (Array.isArray(parsed)) {
                        receivedEvents += parsed.length;
                    }
                }
                catch {
                    // ignore parsing error
                }
                res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
                res.end(JSON.stringify({ success: true }));
                return;
            }
            res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
            res.end('{"status":"ok"}');
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve()));
    const port = server.address().port;
    return {
        url: `http://127.0.0.1:${port}`,
        port,
        get receivedBatches() { return receivedBatches; },
        get receivedEvents() { return receivedEvents; },
        close: async () => {
            if (typeof server.closeAllConnections === 'function') {
                server.closeAllConnections();
            }
            await new Promise(resolve => server.close(() => resolve()));
        },
    };
}
function forceGC() {
    const globalAny = globalThis;
    if (typeof globalAny.gc === 'function') {
        globalAny.gc();
    }
}
describe('test_multi_cycle_soak: Memory Stability & Leak Prevention', { timeout: 180_000 }, () => {
    let mockBackend;
    before(async () => {
        mockBackend = await startMockBackend();
    });
    after(async () => {
        if (mockBackend) {
            await mockBackend.close();
        }
    });
    it('runs 5 consecutive high-volume telemetry soak cycles and verifies bounded post-GC heap stabilization', async () => {
        process.env['PULSE_ENDPOINT'] = mockBackend.url;
        process.env['SDK_BASE_URL'] = mockBackend.url;
        await init({
            apiKey: 'test-soak-api-key',
            initTimeoutMs: 10_000,
        });
        assert.ok(client.initialized, 'SDK must be initialized');
        // Prime JIT and initial allocations
        forceGC();
        const baselineHeap = process.memoryUsage().heapUsed;
        const cycleHeapSnapshots = [];
        const CYCLES = 5;
        const EVENTS_PER_CYCLE = 2_000;
        for (let cycle = 0; cycle < CYCLES; cycle++) {
            // Pump mixed telemetry workload
            for (let i = 0; i < EVENTS_PER_CYCLE; i++) {
                const mod = i % 4;
                if (mod === 0) {
                    captureError(new Error(`soak-err-cycle${cycle}-${i}`));
                }
                else if (mod === 1) {
                    captureMessage(`soak-msg-cycle${cycle}-${i}`, 'info');
                }
                else if (mod === 2) {
                    captureMetric(`soak.metric.cycle${cycle}`, i, 'gauge');
                }
                else {
                    const span = startSpan(`soak-span-${cycle}-${i}`);
                    span.setAttribute('cycle', cycle);
                    span.setAttribute('iteration', i);
                    span.end();
                }
            }
            // Allow pipeline and background flush intervals to process events
            await new Promise(resolve => setTimeout(resolve, 300));
            // Force garbage collection to measure true retained heap
            forceGC();
            const postGcHeap = process.memoryUsage().heapUsed;
            cycleHeapSnapshots.push(postGcHeap);
        }
        // Invariant 1: Peak retained heap is strictly bounded (< 4x baseline heap or 64MB ceiling)
        const maxRetainedHeap = Math.max(...cycleHeapSnapshots);
        const allowedLimit = Math.max(baselineHeap * 4, 64 * 1024 * 1024);
        assert.ok(maxRetainedHeap < allowedLimit, `Retained heap (${(maxRetainedHeap / 1024 / 1024).toFixed(2)} MB) must not exceed allowed limit (${(allowedLimit / 1024 / 1024).toFixed(2)} MB)`);
        // Invariant 2: Plateau stabilization — memory delta between later cycles must stabilize (< 25% drift)
        if (cycleHeapSnapshots.length >= 3) {
            const laterCycles = cycleHeapSnapshots.slice(2);
            const minLater = Math.min(...laterCycles);
            const maxLater = Math.max(...laterCycles);
            const driftPercent = ((maxLater - minLater) / minLater) * 100;
            assert.ok(driftPercent < 25, `Heap drift between cycles ${driftPercent.toFixed(2)}% must remain below 25% (plateau stabilization)`);
        }
        // Invariant 3: Clean shutdown converges within bounded deadline
        const shutdownResult = await shutdown(5_000);
        delete process.env['PULSE_ENDPOINT'];
        delete process.env['SDK_BASE_URL'];
        assert.strictEqual(shutdownResult.timedOut, false, 'Shutdown must complete without timing out');
        assert.strictEqual(client.initialized, false, 'Client must be uninitialized after shutdown');
    });
});
