import http from 'node:http';
import inspector from 'node:inspector';
import { init } from '../../src/core/init.js';
import { shutdown } from '../../src/core/lifecycle.js';
import { startSpan } from '../../src/tracing/tracer.js';
import { captureError } from '../../src/capture/captureError.js';
import { captureMetric, incrementCounter } from '../../src/capture/captureMetric.js';
import { TEST_REMOTE_CONFIG as BAKED_IN_REMOTE_CONFIG } from '../fixtures/remote-config.js';
async function startMockTelemetryServer() {
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', c => chunks.push(Buffer.from(c)));
        req.on('end', () => {
            const port = server.address().port;
            const localUrl = `http://127.0.0.1:${port}`;
            if (req.url === '/v1/init') {
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
                    { ...route, url: `${localUrl}${routePaths[name]}`, batchSize: 500, flushIntervalMs: 50, timeoutMs: 2_000 },
                ]));
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify({
                    success: true,
                    projectId: 'audit-project',
                    environment: 'production',
                    release: '1.0.0',
                    config: {
                        ...BAKED_IN_REMOTE_CONFIG,
                        sdk: { projectId: 'audit-project', service: 'audit-backend', environment: 'production', release: '1.0.0' },
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
                        transport: { ...BAKED_IN_REMOTE_CONFIG.transport, routes },
                    },
                }));
                return;
            }
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ success: true, processed: true }));
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve()));
    const port = server.address().port;
    return {
        url: `http://127.0.0.1:${port}`,
        port,
        close: async () => {
            await new Promise(resolve => server.close(() => resolve()));
        },
    };
}
export async function runCpuProfiling(operations = 5_000) {
    const mockServer = await startMockTelemetryServer();
    process.env['PULSE_ENDPOINT'] = mockServer.url;
    await init({
        apiKey: 'pv_live_audit_test_key_123456789012345678901234.abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
        initTimeoutMs: 3_000,
    });
    const session = new inspector.Session();
    session.connect();
    const post = (method, params) => new Promise((resolve, reject) => {
        session.post(method, params, (err, res) => {
            if (err)
                reject(err);
            else
                resolve(res);
        });
    });
    await post('Profiler.enable');
    await post('Profiler.start');
    const startTime = performance.now();
    // Run intensive telemetry pipeline load
    for (let i = 0; i < operations; i++) {
        const span = startSpan(`audit.profile.span.${i % 10}`);
        span.setAttribute('index', i);
        span.setAttribute('tag', 'hotspot-test');
        span.end();
        incrementCounter('profile_counter', 1, { step: String(i % 5) });
        if (i % 5 === 0) {
            captureError(new Error(`Hotspot error ${i}`));
        }
        if (i % 200 === 0) {
            await new Promise(resolve => setImmediate(resolve));
        }
    }
    const { profile } = await post('Profiler.stop');
    const durationMs = performance.now() - startTime;
    await post('Profiler.disable');
    session.disconnect();
    await shutdown(3_000);
    await mockServer.close();
    // Analyze profile samples and nodes
    const nodes = profile.nodes;
    const samples = profile.samples || [];
    const nodeHitMap = new Map();
    for (const nodeId of samples) {
        nodeHitMap.set(nodeId, (nodeHitMap.get(nodeId) || 0) + 1);
    }
    const hotspots = [];
    const totalSamples = samples.length || 1;
    for (const node of nodes) {
        const hits = nodeHitMap.get(node.id) || node.hitCount || 0;
        if (hits > 0) {
            const percentage = Math.round((hits / totalSamples) * 1000) / 10;
            hotspots.push({
                functionName: node.callFrame.functionName || '(anonymous)',
                url: node.callFrame.url || '(internal)',
                lineNumber: node.callFrame.lineNumber,
                hitCount: hits,
                percentage,
            });
        }
    }
    hotspots.sort((a, b) => b.hitCount - a.hitCount);
    // Identify SDK code hotspots
    const sdkOverheadHotspots = hotspots.filter(h => h.url.includes('sdk-node') ||
        h.url.includes('tracer') ||
        h.url.includes('event-pipeline') ||
        h.url.includes('batch-manager') ||
        h.url.includes('processors'));
    return {
        totalSamples,
        durationMs: Math.round(durationMs * 100) / 100,
        hotspots: hotspots.slice(0, 15),
        sdkOverheadHotspots: sdkOverheadHotspots.slice(0, 10),
    };
}
