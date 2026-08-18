import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { captureCronCheckIn, captureError, captureEvent, captureLog, captureMessage, captureMetric, captureReplay, captureRequest, flushTracer, incrementCounter, init, shutdown, startProfile, startSpan, stopProfile, } from '../../src/index.js';
import { TEST_REMOTE_CONFIG as BAKED_IN_REMOTE_CONFIG } from '../fixtures/remote-config.js';
const ROUTE_PATHS = {
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
async function startMockBackend() {
    const requests = [];
    let origin = '';
    const server = createServer((req, res) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(Buffer.from(chunk)));
        req.on('end', () => {
            const raw = Buffer.concat(chunks);
            const encoding = req.headers['content-encoding'];
            const decoded = encoding === 'gzip' ? gunzipSync(raw).toString('utf8') : raw.toString('utf8');
            const body = decoded ? JSON.parse(decoded) : null;
            const path = req.url ?? '';
            requests.push({ path, contentEncoding: encoding, body });
            res.writeHead(200, { 'content-type': 'application/json' });
            if (path === '/v1/init') {
                res.end(JSON.stringify({
                    success: true,
                    projectId: 'integration-project',
                    environment: 'integration',
                    release: 'remote-release',
                    config: {
                        ...BAKED_IN_REMOTE_CONFIG,
                        sdk: { projectId: 'integration-project', service: 'public-telemetry-test', environment: 'integration', release: 'remote-release' },
                        features: {
                            ...BAKED_IN_REMOTE_CONFIG.features,
                            tracing: true,
                            requestCapture: true,
                            errors: true,
                            metrics: true,
                            logging: true,
                            profiling: true,
                            crons: true,
                            sessionReplay: true,
                        },
                        sampling: {
                            ...BAKED_IN_REMOTE_CONFIG.sampling,
                            traces: 1,
                            requests: 1,
                            errors: 1,
                            profiles: 1,
                            replays: 1,
                            metrics: 1,
                        },
                        killswitches: { ...BAKED_IN_REMOTE_CONFIG.killswitches, disableTransport: false },
                        transport: {
                            ...BAKED_IN_REMOTE_CONFIG.transport,
                            retry: { ...BAKED_IN_REMOTE_CONFIG.transport.retry, enabled: false, maxRetries: 0 },
                            routes: Object.fromEntries(Object.entries(BAKED_IN_REMOTE_CONFIG.transport.routes).map(([name, route]) => [
                                name,
                                {
                                    ...route,
                                    url: `${origin}${ROUTE_PATHS[name]}`,
                                    batchSize: name === 'crons' ? 1 : 50,
                                    flushIntervalMs: 100,
                                    timeoutMs: 2_000,
                                },
                            ])),
                        },
                        meta: { generatedAt: new Date().toISOString(), generatedBy: 'public-telemetry-init-test' },
                    },
                }));
                return;
            }
            if (path === '/v1/sdk-config') {
                const routes = Object.fromEntries(Object.entries(BAKED_IN_REMOTE_CONFIG.transport.routes).map(([name, route]) => [
                    name,
                    {
                        ...route,
                        url: `${origin}${ROUTE_PATHS[name]}`,
                        batchSize: name === 'crons' ? 1 : 50,
                        flushIntervalMs: 100,
                        timeoutMs: 2_000,
                    },
                ]));
                res.end(JSON.stringify({
                    ...BAKED_IN_REMOTE_CONFIG,
                    sdk: { projectId: 'integration-project', service: 'public-telemetry-test', environment: 'integration', release: 'remote-release' },
                    features: {
                        ...BAKED_IN_REMOTE_CONFIG.features,
                        tracing: true,
                        requestCapture: true,
                        errors: true,
                        metrics: true,
                        logging: true,
                        profiling: true,
                        crons: true,
                        sessionReplay: true,
                    },
                    sampling: {
                        ...BAKED_IN_REMOTE_CONFIG.sampling,
                        traces: 1,
                        requests: 1,
                        errors: 1,
                        profiles: 1,
                        replays: 1,
                        metrics: 1,
                    },
                    killswitches: {
                        ...BAKED_IN_REMOTE_CONFIG.killswitches,
                        disableTransport: false,
                    },
                    transport: {
                        ...BAKED_IN_REMOTE_CONFIG.transport,
                        retry: { ...BAKED_IN_REMOTE_CONFIG.transport.retry, enabled: false, maxRetries: 0 },
                        routes,
                    },
                    meta: {
                        generatedAt: new Date().toISOString(),
                        generatedBy: 'public-telemetry-integration-test',
                        configHash: 'public-telemetry-integration-test',
                    },
                }));
                return;
            }
            res.end(JSON.stringify({ ok: true }));
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    origin = `http://127.0.0.1:${address.port}`;
    return {
        url: origin,
        requests,
        async close() {
            closeServerConnections(server);
            await new Promise(resolve => server.close(() => resolve()));
        },
    };
}
function closeServerConnections(server) {
    server.closeIdleConnections();
    server.closeAllConnections();
}
function fnv1a32(input) {
    let hash = 0x811c9dc5;
    for (let index = 0; index < input.length; index++) {
        hash ^= input.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
}
function deterministicProfileId() {
    for (let index = 0; index < 10_000; index++) {
        const candidate = `integration-profile-${index}`;
        if (fnv1a32(candidate) / 0x100000000 < 0.02)
            return candidate;
    }
    throw new Error('Unable to find a deterministic profile ID');
}
function telemetryRequests(requests) {
    return requests.filter(request => Object.values(ROUTE_PATHS).includes(request.path));
}
function eventsFrom(request) {
    assert.ok(request.body && typeof request.body === 'object');
    const events = request.body.events;
    assert.ok(Array.isArray(events), `${request.path} should receive an events envelope`);
    return events;
}
test('public telemetry adapters serialize authoritative application and SDK metadata', { timeout: 30_000 }, async () => {
    const backend = await startMockBackend();
    let initialized = false;
    const initialize = () => init({
        apiKey: 'integration-api-key',
        baseUrl: backend.url,
        applicationName: 'integration-app-override',
        applicationVersion: '9.8.7-test',
        debug: false,
    });
    try {
        await initialize();
        initialized = true;
        captureError(new Error('integration error'), 'error');
        captureMessage('integration message', 'info', { adapter: 'captureMessage' });
        // captureEvent has no separate custom discriminator/route. A custom event
        // therefore uses a supported wire type and carries custom data in context.
        const customReceipt = captureEvent({
            type: 'message',
            message: 'integration custom event',
            severity: 'info',
            timestamp: Date.now(),
            context: { customEventName: 'checkout.completed' },
        });
        assert.equal(customReceipt.accepted, true);
        assert.equal(await customReceipt.processed, true);
        captureRequest({
            type: 'request',
            requestId: 'integration-request',
            url: '/integration',
            method: 'POST',
            statusCode: 201,
            latency: 12,
            timestamp: Date.now(),
        });
        captureMetric('integration.direct.gauge', 42, 'gauge', { tags: { source: 'captureMetric' } });
        incrementCounter('integration.helper.counter', 3, { source: 'incrementCounter' });
        // Registry metrics flush on their own interval. Use the canonical public
        // event API for a deterministic metric wire event in this bounded test.
        const metricReceipt = captureEvent({
            type: 'metric',
            metricName: 'integration.wire.metric',
            metricType: 'gauge',
            value: 42,
            timestamp: Date.now(),
        });
        assert.equal(metricReceipt.accepted, true);
        assert.equal(await metricReceipt.processed, true);
        captureLog('info', 'integration log', { adapter: 'captureLog' });
        captureReplay('integration-session', 1, [{ type: 'click', target: '#submit' }]);
        captureCronCheckIn('integration-cron', 'ok', { duration: 7, environment: 'integration' });
        const profileId = deterministicProfileId();
        assert.equal(await startProfile(profileId), true, 'manual CPU profile should start');
        const workUntil = Date.now() + 10;
        while (Date.now() < workUntil)
            Math.sqrt(Date.now());
        await stopProfile(profileId);
        const span = startSpan('integration-manual-span', { attributes: { adapter: 'startSpan' } });
        span.setStatus('ok');
        span.end();
        await flushTracer();
        const shutdownResult = await shutdown(10_000);
        initialized = false;
        assert.equal(shutdownResult.timedOut, false);
        const received = telemetryRequests(backend.requests);
        assert.ok(received.length > 0, 'mock backend should receive telemetry');
        for (const request of received) {
            const expected = request.path === '/api/v1/checkins' ? undefined : 'gzip';
            assert.equal(request.contentEncoding, expected, `${request.path} compression should follow remote config`);
        }
        const routedEvents = received.flatMap(request => eventsFrom(request).map(event => ({ path: request.path, event })));
        assert.ok(routedEvents.length > 0);
        const expectedMetadata = {
            applicationName: 'integration-app-override',
            applicationVersion: '9.8.7-test',
            sdkName: '@vikasbaplawat1/pulse-sdk',
            sdkVersion: '3.0.0',
            projectId: 'integration-project',
        };
        for (const { path, event } of routedEvents) {
            assert.ok(event.metadata, `${event.type} on ${path} should have metadata`);
            for (const [field, expected] of Object.entries(expectedMetadata)) {
                assert.equal(event.metadata[field], expected, `${event.type} metadata.${field}`);
            }
        }
        const expectedRoutes = {
            error: '/api/v1/errors',
            message: '/api/v1/events',
            request: '/api/v1/requests',
            metric: '/api/v1/metrics',
            log: '/api/v1/logs',
            profile: '/api/v1/profiles',
            replay: '/api/v1/replays',
            cron_checkin: '/api/v1/checkins',
            span: '/api/v1/spans',
            trace: '/api/v1/traces',
        };
        for (const [type, path] of Object.entries(expectedRoutes)) {
            assert.ok(routedEvents.some(receivedEvent => receivedEvent.event.type === type && receivedEvent.path === path), `expected ${type} on ${path}`);
        }
        const metricNames = routedEvents
            .filter(({ event }) => event.type === 'metric')
            .map(({ event }) => event.metricName);
        assert.ok(metricNames.includes('integration.wire.metric'));
        assert.ok(metricNames.includes('integration.direct.gauge'), 'captureMetric aggregate should flush during shutdown');
        assert.ok(metricNames.includes('integration.helper.counter'), 'incrementCounter aggregate should flush during shutdown');
        assert.equal(received.some(request => request.path === '/api/v1/events'), true);
    }
    finally {
        if (initialized)
            await shutdown(10_000);
        await backend.close();
    }
});
