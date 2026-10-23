import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import { gunzipSync } from 'node:zlib';
import { init } from '../../src/core/init.js';
import { shutdown, flush } from '../../src/core/lifecycle.js';
import { captureException } from '../../src/capture/captureException.js';
import { lynktraceMiddleware, expressErrorHandler } from '../../src/instrumentation/express.js';
import { createContextStore, withContext } from '../../src/core/context.js';
import { TEST_REMOTE_CONFIG as BAKED_IN_REMOTE_CONFIG } from '../fixtures/remote-config.js';
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
async function startMockBackend() {
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
            if (req.url === '/v1/init' || req.url === '/api/v1/init') {
                const port = server.address().port;
                const localUrl = `http://127.0.0.1:${port}`;
                const paths = { errors: '/api/v1/errors', events: '/api/v1/events', requests: '/api/v1/requests' };
                const routes = Object.fromEntries(Object.entries(BAKED_IN_REMOTE_CONFIG.transport.routes).map(([name, route]) => [
                    name,
                    { ...route, url: `${localUrl}${paths[name] || '/api/v1/unknown'}`, batchSize: 1, flushIntervalMs: 20, timeoutMs: 2_000 },
                ]));
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify({
                    success: true,
                    projectId: 'proj-test',
                    environment: 'test',
                    release: '1.0.0',
                    config: {
                        ...BAKED_IN_REMOTE_CONFIG,
                        sdk: { projectId: 'proj-test', service: 'classification-test', environment: 'test', release: '1.0.0' },
                        features: { ...BAKED_IN_REMOTE_CONFIG.features, tracing: true, requestCapture: true, errors: true, metrics: true },
                        sampling: { ...BAKED_IN_REMOTE_CONFIG.sampling, traces: 1, requests: 1, errors: 1, metrics: 1 },
                        killswitches: { ...BAKED_IN_REMOTE_CONFIG.killswitches, disableTransport: false },
                        transport: { ...BAKED_IN_REMOTE_CONFIG.transport, routes },
                    },
                }));
                return;
            }
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: true, accepted: 1 }));
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve()));
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
            return new Promise((resolve, reject) => {
                server.close(err => (err ? reject(err) : resolve()));
            });
        },
    };
}
function getErrorEvents(backend) {
    const eventsRoute = backend.requests.filter(req => req.path === '/api/v1/events');
    const errorsRoute = backend.requests.filter(req => req.path === '/api/v1/errors');
    const allEvents = [];
    for (const req of [...eventsRoute, ...errorsRoute]) {
        if (Array.isArray(req.body)) {
            allEvents.push(...req.body);
        }
        else if (req.body && req.body.events && Array.isArray(req.body.events)) {
            allEvents.push(...req.body.events);
        }
        else if (req.body && req.body.type === 'error') {
            allEvents.push(req.body);
        }
    }
    return allEvents;
}
describe('SDK Error Classification Wire Payloads', () => {
    let mock;
    before(async () => {
        mock = await startMockBackend();
        await init({
            apiKey: 'pk_live_error_classification_test',
            applicationName: 'test-app',
            applicationVersion: '1.0.0',
        });
    });
    after(async () => {
        await shutdown();
        await mock.close();
    });
    beforeEach(() => {
        mock.reset();
    });
    it('1. manual captureException(err) emits unhandled=false, fatal=false, crash=false', async () => {
        captureException(new Error('Manual handled test error'), 'error');
        await flush();
        await delay(100);
        const events = getErrorEvents(mock);
        assert.ok(events.length >= 1, `Expected at least 1 error event, got ${events.length}`);
        const event = events.find(e => e.message === 'Manual handled test error');
        assert.ok(event, 'Found manual test error event');
        assert.strictEqual(event.handled, true);
        assert.strictEqual(event.mechanism, 'manual');
        assert.strictEqual(event.severity, 'error');
        assert.deepStrictEqual(event.classification, {
            unhandled: false,
            fatal: false,
            crash: false,
        });
    });
    it('2. manual fatal captureException(err, "fatal") emits unhandled=false, fatal=true, crash=false', async () => {
        captureException(new Error('Manual fatal infrastructure error'), 'fatal');
        await flush();
        await delay(100);
        const events = getErrorEvents(mock);
        assert.ok(events.length >= 1, `Expected at least 1 error event, got ${events.length}`);
        const event = events.find(e => e.message === 'Manual fatal infrastructure error');
        assert.ok(event, 'Found fatal test error event');
        assert.strictEqual(event.handled, true);
        assert.strictEqual(event.mechanism, 'manual');
        assert.strictEqual(event.severity, 'fatal');
        assert.deepStrictEqual(event.classification, {
            unhandled: false,
            fatal: true,
            crash: false,
        });
    });
    it('3. Express next(err) route error emits unhandled=false, fatal=false, crash=false', async () => {
        const app = express();
        app.use(lynktraceMiddleware());
        app.get('/test-express-error', (_req, _res, next) => {
            next(new Error('Express routed calculation error'));
        });
        app.use(expressErrorHandler());
        const server = http.createServer(app);
        await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve()));
        const port = server.address().port;
        try {
            await fetch(`http://127.0.0.1:${port}/test-express-error`);
            await flush();
            await delay(100);
            const events = getErrorEvents(mock);
            const event = events.find(e => e.message === 'Express routed calculation error');
            assert.ok(event, 'Found Express error event');
            assert.strictEqual(event.handled, true);
            assert.strictEqual(event.mechanism, 'express.next');
            assert.strictEqual(event.severity, 'error');
            assert.deepStrictEqual(event.classification, {
                unhandled: false,
                fatal: false,
                crash: false,
            });
        }
        finally {
            await new Promise(resolve => server.close(() => resolve()));
        }
    });
    it('4. uncaughtException handler context emits unhandled=true, fatal=true, crash=true', async () => {
        const store = createContextStore('uncaught-test', 10, {
            extra: { mechanism: 'uncaughtException', handled: false },
        });
        withContext(store, () => {
            captureException(new Error('Uncaught process exception'), 'fatal');
        });
        await flush();
        await delay(100);
        const events = getErrorEvents(mock);
        const event = events.find(e => e.message === 'Uncaught process exception');
        assert.ok(event, 'Found uncaught exception event');
        assert.strictEqual(event.handled, false);
        assert.strictEqual(event.mechanism, 'uncaughtException');
        assert.strictEqual(event.severity, 'fatal');
        assert.deepStrictEqual(event.classification, {
            unhandled: true,
            fatal: true,
            crash: true,
        });
    });
    it('5. unhandledRejection handler context emits unhandled=true, fatal=false, crash=false', async () => {
        const store = createContextStore('unhandled-rejection-test', 10, {
            extra: { mechanism: 'unhandledRejection', handled: false },
        });
        withContext(store, () => {
            captureException(new Error('Unhandled promise rejection'), 'error');
        });
        await flush();
        await delay(100);
        const events = getErrorEvents(mock);
        const event = events.find(e => e.message === 'Unhandled promise rejection');
        assert.ok(event, 'Found unhandled rejection event');
        assert.strictEqual(event.handled, false);
        assert.strictEqual(event.mechanism, 'unhandledRejection');
        assert.strictEqual(event.severity, 'error');
        assert.deepStrictEqual(event.classification, {
            unhandled: true,
            fatal: false,
            crash: false,
        });
    });
});
