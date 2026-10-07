import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import http from 'node:http';
import { init } from '../../src/core/init.js';
import { shutdown, flush } from '../../src/core/lifecycle.js';
import { captureException } from '../../src/capture/captureException.js';
import { captureRequest } from '../../src/capture/captureRequest.js';
import { quotaController } from '../../src/core/quota-controller.js';
import { TEST_REMOTE_CONFIG as BAKED_IN_REMOTE_CONFIG } from '../fixtures/remote-config.js';
describe('Transport Resilience & Quota Recovery Integration', () => {
    let server;
    let serverUrl;
    let responseMode = 'ok';
    let requestsReceived = [];
    before(async () => {
        server = http.createServer((req, res) => {
            const chunks = [];
            req.on('data', chunk => chunks.push(Buffer.from(chunk)));
            req.on('end', () => {
                const raw = Buffer.concat(chunks);
                const isGzip = req.headers['content-encoding'] === 'gzip';
                let body = null;
                try {
                    const decoded = isGzip ? gunzipSync(raw).toString('utf8') : raw.toString('utf8');
                    body = decoded ? JSON.parse(decoded) : null;
                }
                catch { }
                requestsReceived.push({
                    path: req.url ?? '',
                    headers: req.headers,
                    body,
                });
                if (req.url?.includes('init') || req.url?.includes('sdk-config')) {
                    const routes = Object.fromEntries(Object.entries(BAKED_IN_REMOTE_CONFIG.transport.routes).map(([name, route]) => [
                        name,
                        { ...route, url: `${serverUrl}/v1/${name}`, batchSize: 2, flushIntervalMs: 50, timeoutMs: 2_000 },
                    ]));
                    const cfg = {
                        ...BAKED_IN_REMOTE_CONFIG,
                        features: {
                            ...BAKED_IN_REMOTE_CONFIG.features,
                            errors: true,
                            requestCapture: true,
                            tracing: true,
                        },
                        sampling: {
                            ...BAKED_IN_REMOTE_CONFIG.sampling,
                            traces: 1,
                            requests: 1,
                            errors: 1,
                        },
                        entitlements: {
                            ...BAKED_IN_REMOTE_CONFIG.entitlements,
                            tracing: true,
                            errors: true,
                            requestCapture: true,
                        },
                        transport: {
                            ...BAKED_IN_REMOTE_CONFIG.transport,
                            routes,
                        },
                    };
                    res.writeHead(200, { 'content-type': 'application/json' });
                    res.end(JSON.stringify({
                        success: true,
                        projectId: cfg.sdk.projectId,
                        environment: cfg.sdk.environment,
                        release: cfg.sdk.release,
                        config: cfg,
                    }));
                    return;
                }
                if (responseMode === '429_retry_after') {
                    res.writeHead(429, {
                        'content-type': 'application/json',
                        'retry-after': '60',
                        'x-pulse-quota-status': 'exhausted',
                    });
                    res.end(JSON.stringify({ error: 'quota_exceeded' }));
                    return;
                }
                if (responseMode === '500_transient') {
                    res.writeHead(500, { 'content-type': 'application/json' });
                    res.end(JSON.stringify({ error: 'internal_server_error' }));
                    return;
                }
                if (responseMode === '400_poisoned') {
                    res.writeHead(400, { 'content-type': 'application/json' });
                    res.end(JSON.stringify({ error: 'invalid_payload' }));
                    return;
                }
                // Default 200 OK
                res.writeHead(200, {
                    'content-type': 'application/json',
                    'x-pulse-quota-status': 'ok',
                });
                res.end(JSON.stringify({ status: 'ok', accepted: true }));
            });
        });
        await new Promise(resolve => {
            server.listen(0, '127.0.0.1', () => {
                const addr = server.address();
                if (typeof addr === 'object' && addr !== null) {
                    serverUrl = `http://127.0.0.1:${addr.port}`;
                    process.env.SDK_BASE_URL = serverUrl;
                    process.env.PULSE_BASE_URL = serverUrl;
                }
                resolve();
            });
        });
    });
    after(async () => {
        delete process.env.SDK_BASE_URL;
        delete process.env.PULSE_BASE_URL;
        await shutdown(1000);
        await new Promise(resolve => server.close(() => resolve()));
    });
    it('handles 429 quota exhaustion gracefully and auto-recovers on 200 OK without restart', async () => {
        requestsReceived = [];
        responseMode = 'ok';
        await init({
            apiKey: 'pv_test_resilience_key',
            debug: false,
        });
        // 1. Initial capture in OK state
        captureRequest({
            type: 'request',
            requestId: 'req-init-1',
            url: '/api/users',
            method: 'GET',
            statusCode: 200,
            latency: 15,
            timestamp: Date.now(),
        });
        captureRequest({
            type: 'request',
            requestId: 'req-init-2',
            url: '/api/orders',
            method: 'GET',
            statusCode: 200,
            latency: 20,
            timestamp: Date.now(),
        });
        await flush();
        assert.equal(quotaController.isExhausted(), false);
        // 2. Server begins returning 429 with Quota Exhausted
        responseMode = '429_retry_after';
        captureRequest({
            type: 'request',
            requestId: 'req-429-1',
            url: '/api/checkout',
            method: 'POST',
            statusCode: 200,
            latency: 35,
            timestamp: Date.now(),
        });
        captureRequest({
            type: 'request',
            requestId: 'req-429-2',
            url: '/api/pay',
            method: 'POST',
            statusCode: 200,
            latency: 40,
            timestamp: Date.now(),
        });
        await flush();
        assert.equal(quotaController.isExhausted(), true);
        // 3. Application continues running safely without throws during exhaustion
        captureRequest({
            type: 'request',
            requestId: 'req-during-exhaustion',
            url: '/api/test',
            method: 'GET',
            statusCode: 200,
            latency: 10,
            timestamp: Date.now(),
        });
        // 4. Server recovers to 200 OK — P0 fatal error is admitted even when exhausted and triggers ACK
        responseMode = 'ok';
        captureException(new Error('fatal recovery error'), 'fatal');
        await flush();
        // Automatic recovery verified without server restart!
        assert.equal(quotaController.getState(), 'QUOTA_OK');
        assert.equal(quotaController.isExhausted(), false);
    });
});
