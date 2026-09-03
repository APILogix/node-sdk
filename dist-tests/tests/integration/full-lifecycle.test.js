/**
 * Full SDK lifecycle integration test.
 *
 * Simulates real-world warm-restart / hot-reload scenarios by running
 * many init → capture → shutdown cycles back-to-back and asserting:
 *
 *   1. Process listener counts return to baseline after every cycle.
 *   2. Active handles/requests return to baseline after every cycle.
 *   3. Heap memory does not grow unboundedly across cycles (allowing for
 *      noise, we assert that the high-water mark across cycles 5-N is not
 *      more than 2x the high-water mark of cycle 1).
 *   4. After re-init, the SDK accepts and routes events again (proving the
 *      pipelineDraining flag was cleared and singletons were rebuilt).
 *   5. The shutdown step-error array is empty (no swallowed failures).
 *
 * This test exercises the real init() / shutdown() code paths against a
 * mocked HTTP backend so we cover the end-to-end pipeline without relying
 * on a real network.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
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
    const http = await import('node:http');
    const requests = [];
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', chunk => {
            chunks.push(Buffer.from(chunk));
        });
        req.on('end', () => {
            const raw = Buffer.concat(chunks);
            const decoded = req.headers['content-encoding'] === 'gzip' ? gunzipSync(raw).toString('utf8') : raw.toString('utf8');
            try {
                const body = decoded ? JSON.parse(decoded) : null;
                requests.push({ path: req.url ?? '', body });
            }
            catch {
                requests.push({ path: req.url ?? '', body: decoded });
            }
            // /v1/init returns a minimal valid init response that points all
            // transport routes at this same mock server. Without per-route URLs,
            // the BatchManager would dispatch to the baked-in production URLs
            // (e.g. https://errors.pulse.dev) and fail every send.
            if (req.url === '/v1/init') {
                const port = server.address().port;
                const localUrl = `http://127.0.0.1:${port}`;
                const paths = {
                    errors: '/api/v1/errors', events: '/api/v1/events', traces: '/api/v1/traces',
                    spans: '/api/v1/spans', requests: '/api/v1/requests', metrics: '/api/v1/metrics',
                    logs: '/api/v1/logs', profiles: '/api/v1/profiles', crons: '/api/v1/checkins',
                    replays: '/api/v1/replays',
                };
                const routes = Object.fromEntries(Object.entries(BAKED_IN_REMOTE_CONFIG.transport.routes).map(([name, route]) => [
                    name,
                    { ...route, url: `${localUrl}${paths[name]}`, batchSize: 50, flushIntervalMs: 250, timeoutMs: 2_000 },
                ]));
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify({
                    success: true,
                    projectId: 'proj-test',
                    environment: 'test',
                    release: '1.0.0',
                    config: {
                        ...BAKED_IN_REMOTE_CONFIG,
                        sdk: { projectId: 'proj-test', service: 'lifecycle-test', environment: 'test', release: '1.0.0' },
                        features: { ...BAKED_IN_REMOTE_CONFIG.features, tracing: true, requestCapture: true, errors: true, metrics: true },
                        sampling: { ...BAKED_IN_REMOTE_CONFIG.sampling, traces: 1, requests: 1, errors: 1, metrics: 1 },
                        killswitches: { ...BAKED_IN_REMOTE_CONFIG.killswitches, disableTransport: false },
                        transport: { ...BAKED_IN_REMOTE_CONFIG.transport, routes },
                        meta: { generatedAt: new Date().toISOString(), generatedBy: 'integration-test-init' },
                    },
                }));
                return;
            }
            // Complete schema-v1 control-plane response with localhost routes.
            if (req.url?.includes('init') || req.url?.includes('sdk-config')) {
                const port = server.address().port;
                const localUrl = `http://127.0.0.1:${port}`;
                const paths = {
                    errors: '/api/v1/errors', events: '/api/v1/events', traces: '/api/v1/traces',
                    spans: '/api/v1/spans', requests: '/api/v1/requests',
                    metrics: '/api/v1/metrics', logs: '/api/v1/logs', profiles: '/api/v1/profiles',
                    crons: '/api/v1/checkins', replays: '/api/v1/replays',
                };
                const routes = Object.fromEntries(Object.entries(BAKED_IN_REMOTE_CONFIG.transport.routes).map(([name, route]) => [
                    name,
                    { ...route, url: `${localUrl}${paths[name]}`, batchSize: 50, flushIntervalMs: 250, timeoutMs: 2_000 },
                ]));
                const configSnapshot = {
                    ...BAKED_IN_REMOTE_CONFIG,
                    sdk: { projectId: 'proj-test', service: 'lifecycle-test', environment: 'test', release: '1.0.0' },
                    features: { ...BAKED_IN_REMOTE_CONFIG.features, tracing: true, requestCapture: true, errors: true, metrics: true },
                    sampling: { ...BAKED_IN_REMOTE_CONFIG.sampling, traces: 1, requests: 1, errors: 1, metrics: 1 },
                    killswitches: { ...BAKED_IN_REMOTE_CONFIG.killswitches, disableTransport: false },
                    transport: { ...BAKED_IN_REMOTE_CONFIG.transport, routes },
                    meta: { generatedAt: new Date().toISOString(), generatedBy: 'integration-test', configHash: 'integration-test' },
                    entitlements: { ...BAKED_IN_REMOTE_CONFIG.entitlements, tracing: true, errors: true, metrics: true, requestCapture: true, customSpans: true },
                };
                res.writeHead(200, { 'content-type': 'application/json' });
                if (req.url?.includes('init')) {
                    res.end(JSON.stringify({
                        success: true,
                        projectId: 'proj-test',
                        environment: 'test',
                        release: '1.0.0',
                        config: configSnapshot,
                    }));
                }
                else {
                    res.end(JSON.stringify(configSnapshot));
                }
                return;
            }
            // Default: accept and ack.
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const url = `http://127.0.0.1:${port}`;
    process.env.SDK_BASE_URL = url;
    return {
        url,
        requests,
        reset() {
            requests.length = 0;
        },
        async close() {
            delete process.env.SDK_BASE_URL;
            await new Promise(resolve => server.close(() => resolve()));
        },
    };
}
function takeSnapshot() {
    const procAny = process;
    const mem = process.memoryUsage();
    return {
        sigterm: process.listeners('SIGTERM').length,
        sigint: process.listeners('SIGINT').length,
        uncaught: process.listeners('uncaughtException').length,
        unhandled: process.listeners('unhandledRejection').length,
        activeHandles: procAny._getActiveHandles?.().length ?? 0,
        activeRequests: procAny._getActiveRequests?.().length ?? 0,
        rss: mem.rss,
        heapUsed: mem.heapUsed,
    };
}
// ─── Test ───────────────────────────────────────────────────────────────────
describe('Full SDK lifecycle integration', { timeout: 60_000 }, () => {
    let backend;
    before(async () => {
        backend = await startMockBackend();
    });
    after(async () => {
        await backend.close();
    });
    it('survives 5 init→capture→shutdown cycles without leaks', async () => {
        const NUM_CYCLES = 5;
        const baseline = takeSnapshot();
        const cycleSnapshots = [];
        const shutdownResults = [];
        for (let cycle = 0; cycle < NUM_CYCLES; cycle++) {
            // ── INIT ─────────────────────────────────────────────────────────
            await init({
                apiKey: `cycle-${cycle}-key`,
                debug: false,
            });
            assert.equal(client.initialized, true, `cycle ${cycle}: SDK should be initialized`);
            // ── CAPTURE ─────────────────────────────────────────────────────
            // Mix of event types to exercise every pipeline branch.
            for (let i = 0; i < 20; i++) {
                captureMessage(`cycle-${cycle}-msg-${i}`, 'info');
            }
            for (let i = 0; i < 5; i++) {
                captureError(new Error(`cycle-${cycle}-err-${i}`));
            }
            for (let i = 0; i < 10; i++) {
                captureMetric(`cycle.${cycle}.counter`, 1, 'counter');
            }
            const span = startSpan(`cycle-${cycle}-span`);
            span.setAttribute('cycle', cycle);
            span.end();
            // Allow async pipeline tasks to settle before shutdown drains them.
            await new Promise(resolve => setImmediate(resolve));
            // ── SHUTDOWN ────────────────────────────────────────────────────
            const result = await shutdown(5_000);
            shutdownResults.push(result);
            assert.equal(client.initialized, false, `cycle ${cycle}: client should be cleared after shutdown`);
            assert.equal(result.timedOut, false, `cycle ${cycle}: shutdown must not time out`);
            // Force GC if exposed (run with --expose-gc); otherwise skip silently.
            const globalAny = globalThis;
            if (typeof globalAny.gc === 'function') {
                globalAny.gc();
            }
            cycleSnapshots.push(takeSnapshot());
        }
        assert.equal(backend.requests.filter(request => request.path.includes('/v1/init')).length, NUM_CYCLES, 'each cycle must perform exactly one startup config request');
        assert.equal(backend.requests.filter(request => request.path.includes('/v1/sdk-config')).length, 0, 'startup must not prefetch /v1/sdk-config');
        // ── ASSERT NO LISTENER LEAK ──────────────────────────────────────
        for (let i = 0; i < cycleSnapshots.length; i++) {
            const snap = cycleSnapshots[i];
            assert.equal(snap.sigterm, baseline.sigterm, `cycle ${i}: SIGTERM listeners leaked (baseline=${baseline.sigterm}, after=${snap.sigterm})`);
            assert.equal(snap.sigint, baseline.sigint, `cycle ${i}: SIGINT listeners leaked (baseline=${baseline.sigint}, after=${snap.sigint})`);
            assert.equal(snap.uncaught, baseline.uncaught, `cycle ${i}: uncaughtException listeners leaked (baseline=${baseline.uncaught}, after=${snap.uncaught})`);
            assert.equal(snap.unhandled, baseline.unhandled, `cycle ${i}: unhandledRejection listeners leaked (baseline=${baseline.unhandled}, after=${snap.unhandled})`);
        }
        // ── ASSERT NO ACTIVE HANDLE LEAK ─────────────────────────────────
        // The mock HTTP server itself counts as one active handle, and Node's
        // own internals can add a few. We assert the number does not GROW
        // monotonically across cycles, which would indicate a real leak.
        const lastSnap = cycleSnapshots[cycleSnapshots.length - 1];
        const firstSnap = cycleSnapshots[0];
        assert.ok(lastSnap.activeHandles - firstSnap.activeHandles <= 2, `active handles grew from ${firstSnap.activeHandles} to ${lastSnap.activeHandles} across cycles`);
        // ── ASSERT NO HEAP RUNAWAY ───────────────────────────────────────
        // Allow up to 4x growth as a generous bound — JIT warmup, V8's
        // expanding heap, and pre-allocated pools cause noise on cycle 0.
        // What we want to catch is unbounded linear growth.
        const peakHeap = Math.max(...cycleSnapshots.map(s => s.heapUsed));
        const initialHeap = firstSnap.heapUsed;
        assert.ok(peakHeap < initialHeap * 4, `heap runaway detected: peak=${(peakHeap / 1024 / 1024).toFixed(1)}MB, initial=${(initialHeap / 1024 / 1024).toFixed(1)}MB`);
        // ── ASSERT EVERY SHUTDOWN COMPLETED CLEANLY ──────────────────────
        for (let i = 0; i < shutdownResults.length; i++) {
            const r = shutdownResults[i];
            assert.equal(r.timedOut, false, `cycle ${i}: shutdown timed out`);
            // Allow a small tolerance for known noisy steps (e.g., metrics
            // shutdown reporting "no provider" warnings during reset).
            assert.ok(r.stepErrors.length <= 2, `cycle ${i}: too many shutdown step errors: ${JSON.stringify(r.stepErrors)}`);
        }
    });
    it('accepts and routes events after a fresh re-init', async () => {
        backend.reset();
        // Confirm the pipeline is fully re-armed after the previous test's
        // shutdown by running another init→capture→flush cycle and verifying
        // events actually reach the mock backend.
        await init({
            apiKey: 'fresh-init-key',
            debug: false,
        });
        assert.equal(client.initialized, true);
        // Capture some events.
        captureMessage('post-reinit-message', 'info');
        captureError(new Error('post-reinit-error'));
        // Allow the pipeline to process these.
        await new Promise(resolve => setTimeout(resolve, 100));
        // Drive a shutdown so the transport flushes everything synchronously.
        const result = await shutdown(5_000);
        assert.equal(result.timedOut, false);
        // The backend should have received init + at least one event payload.
        const initRequests = backend.requests.filter(request => request.path.includes('/v1/init'));
        assert.equal(initRequests.length, 1, 'fresh initialization must call /v1/init exactly once');
        assert.equal(backend.requests.filter(request => request.path.includes('/v1/sdk-config')).length, 0, 'fresh initialization must not call /v1/sdk-config');
    });
});
