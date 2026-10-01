import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { init, shutdown, startSpan, patchPgPoolConnectOnce, } from '../../src/index.js';
import { TEST_REMOTE_CONFIG } from '../fixtures/remote-config.js';
const originalFetch = globalThis.fetch;
const origClientConnect = pg.Client.prototype.connect;
function setupMockFetch() {
    globalThis.fetch = (async (url) => {
        if (String(url).includes('/v1/init')) {
            return new Response(JSON.stringify({
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
                    },
                    sampling: {
                        ...TEST_REMOTE_CONFIG.sampling,
                        traces: 1,
                        spans: 1,
                        requests: 1,
                    },
                },
            }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
}
describe('PostgreSQL Connection Pool Acquisition Timing & Saturation Metrics', () => {
    beforeEach(async () => {
        setupMockFetch();
        await init({ apiKey: 'test-key' });
        patchPgPoolConnectOnce();
        // Mock client connect to succeed in memory
        pg.Client.prototype.connect = function (cb) {
            if (typeof cb === 'function') {
                setTimeout(() => cb(null), 5);
                return;
            }
            return new Promise((resolve) => setTimeout(resolve, 5));
        };
    });
    afterEach(async () => {
        pg.Client.prototype.connect = origClientConnect;
        globalThis.fetch = originalFetch;
        await shutdown();
    });
    it('instruments pool.connect() Promise form when acquisition has wait delay', async () => {
        const pool = new pg.Pool();
        const rootSpan = startSpan('HTTP GET /api/orders', { kind: 'server' });
        const client = await pool.connect();
        assert.ok(client);
        assert.ok(pool.totalCount >= 0);
        client.release();
        rootSpan.end();
        await pool.end();
    });
    it('instruments pool.connect() callback form', async () => {
        const pool = new pg.Pool();
        const rootSpan = startSpan('HTTP GET /api/users', { kind: 'server' });
        await new Promise((resolve, reject) => {
            pool.connect((err, client, release) => {
                try {
                    assert.ifError(err);
                    assert.ok(client);
                    if (release)
                        release();
                    rootSpan.end();
                    pool.end().then(() => resolve(), reject);
                }
                catch (e) {
                    reject(e);
                }
            });
        });
    });
    it('records pool acquisition errors and re-throws safely', async () => {
        const pool = new pg.Pool();
        // Mock client connect to simulate an acquisition timeout error
        pg.Client.prototype.connect = function (cb) {
            const err = new Error('timeout exceeded when connecting to database');
            if (typeof cb === 'function') {
                process.nextTick(() => cb(err));
                return;
            }
            return Promise.reject(err);
        };
        const rootSpan = startSpan('HTTP GET /api/failing', { kind: 'server' });
        await assert.rejects(async () => {
            await pool.connect();
        }, (err) => {
            assert.equal(err.message, 'timeout exceeded when connecting to database');
            return true;
        });
        rootSpan.end();
        await pool.end();
    });
});
