import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { BAKED_IN_REMOTE_CONFIG } from '../../src/constants/defaults.js';
import { TransportRouter } from '../../src/transport/transport-router.js';
function config(base = 'https://collector.example.test') {
    const existing = BAKED_IN_REMOTE_CONFIG.transport;
    return {
        ...existing,
        endpoints: {
            ...existing.endpoints,
            errors: { ...existing.endpoints.errors, url: `${base}/custom-errors` },
            traces: { ...existing.endpoints.traces, url: `${base}/custom-traces` },
            metrics: { ...existing.endpoints.metrics, url: `${base}/custom-metrics` },
        },
        shared: {
            ...existing.shared,
            connectionPool: {
                maxConnectionsPerRoute: 999,
                maxTotalConnections: 100,
            },
        },
    };
}
function event(type, index) {
    switch (type) {
        case 'error':
            return {
                type,
                eventId: `err-${index}`,
                message: 'boom',
                name: 'Error',
                stack: [],
                fingerprint: `fp-${index}`,
                timestamp: Date.now(),
                severity: 'error',
                context: {},
            };
        case 'span':
            return {
                type,
                eventId: `span-${index}`,
                spanId: `span${index}`,
                traceId: `trace${index}`,
                name: 'op',
                startTime: Date.now(),
                endTime: Date.now() + 1,
                duration: 1,
                status: 'ok',
            };
        case 'request':
            return {
                type,
                eventId: `req-${index}`,
                requestId: `req-${index}`,
                url: '/orders',
                method: 'GET',
                statusCode: 200,
                latency: 1,
                timestamp: Date.now(),
            };
        case 'metric':
            return {
                type,
                eventId: `metric-${index}`,
                metricName: 'http.server.duration',
                metricType: 'histogram',
                value: index,
                timestamp: Date.now(),
            };
        default:
            return {
                type: 'message',
                eventId: `msg-${index}`,
                message: 'message',
                severity: 'info',
                timestamp: Date.now(),
            };
    }
}
function okResponse() {
    return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
    });
}
describe('Unified TransportRouter', () => {
    afterEach(async () => {
        await TransportRouter.getInstance()?.shutdown();
    });
    it('routes event types to deterministic endpoints', async () => {
        const calls = [];
        const fetchImpl = async (url, options) => {
            calls.push({ url: String(url), body: JSON.parse(String(options?.body)) });
            return okResponse();
        };
        const router = await TransportRouter.initialize(config(), 'test-key', fetchImpl);
        router.send(event('error', 1));
        router.send(event('span', 1));
        router.send(event('request', 1));
        router.send(event('metric', 1));
        await router.flushAll();
        const urls = calls.map(call => new URL(call.url).pathname);
        assert.ok(urls.includes('/v1/errors'));
        assert.ok(urls.includes('/v1/traces'));
        assert.ok(urls.includes('/v1/metrics'));
        const traceCall = calls.find(call => new URL(call.url).pathname === '/v1/traces');
        assert.deepEqual(traceCall?.body.events.map((e) => e.type).sort(), ['request', 'span']);
    });
    it('hard-enforces per-route and global in-flight connection limits', async () => {
        const active = { errors: 0, traces: 0, metrics: 0 };
        const maxActive = { errors: 0, traces: 0, metrics: 0, total: 0 };
        const fetchImpl = async (url) => {
            const path = new URL(String(url)).pathname;
            const route = path.includes('errors') ? 'errors' : path.includes('traces') ? 'traces' : 'metrics';
            active[route]++;
            maxActive[route] = Math.max(maxActive[route], active[route]);
            maxActive.total = Math.max(maxActive.total, active.errors + active.traces + active.metrics);
            await new Promise(resolve => setTimeout(resolve, 25));
            active[route]--;
            return okResponse();
        };
        const router = await TransportRouter.initialize(config(), 'test-key', fetchImpl);
        for (let i = 0; i < 3_000; i++)
            router.send(event('error', i));
        for (let i = 0; i < 10_000; i++)
            router.send(event('span', i));
        for (let i = 0; i < 10_000; i++)
            router.send(event('metric', i));
        await router.flushAll();
        assert.ok(maxActive.errors <= 30, `errors exceeded limit: ${maxActive.errors}`);
        assert.ok(maxActive.traces <= 50, `traces exceeded limit: ${maxActive.traces}`);
        assert.ok(maxActive.metrics <= 20, `metrics exceeded limit: ${maxActive.metrics}`);
        assert.ok(maxActive.total <= 100, `global exceeded limit: ${maxActive.total}`);
    });
    it('keeps error delivery isolated while traces are backlogged', async () => {
        let firstErrorAt = 0;
        const startedAt = Date.now();
        const fetchImpl = async (url) => {
            const path = new URL(String(url)).pathname;
            if (path === '/v1/traces') {
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            if (path === '/v1/errors' && firstErrorAt === 0) {
                firstErrorAt = Date.now();
            }
            return okResponse();
        };
        const router = await TransportRouter.initialize(config(), 'test-key', fetchImpl);
        for (let i = 0; i < 76_000; i++)
            router.send(event('span', i));
        for (let i = 0; i < 100; i++)
            router.send(event('error', i));
        await router.flushAll();
        const debug = router.getDebugState();
        assert.ok(firstErrorAt > 0);
        assert.ok(firstErrorAt - startedAt < 2_000, `error delivery took ${firstErrorAt - startedAt}ms`);
        assert.ok(debug.droppedEvents.some((drop) => drop.route === 'traces' && drop.reason === 'queue_full'));
    });
    it('batches steady-state metrics efficiently', async () => {
        let metricRequests = 0;
        let metricEvents = 0;
        const fetchImpl = async (url, options) => {
            if (new URL(String(url)).pathname === '/v1/metrics') {
                metricRequests++;
                metricEvents += JSON.parse(String(options?.body)).events.length;
            }
            return okResponse();
        };
        const router = await TransportRouter.initialize(config(), 'test-key', fetchImpl);
        for (let i = 0; i < 2_000; i++)
            router.send(event('metric', i));
        await router.flushAll();
        assert.equal(metricEvents, 2_000);
        assert.ok(metricRequests <= 3, `expected efficient batching, got ${metricRequests} requests`);
        assert.ok(metricEvents / metricRequests >= 800);
    });
});
