import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { init, shutdown, withDbSpan, withDbSpanSync, Pulse, } from '../../src/index.js';
import { TEST_REMOTE_CONFIG } from '../fixtures/remote-config.js';
const originalFetch = globalThis.fetch;
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
describe('Slow Database Query Detection & Tagging', () => {
    beforeEach(async () => {
        setupMockFetch();
        await init({ apiKey: 'test-key' });
    });
    afterEach(async () => {
        globalThis.fetch = originalFetch;
        await shutdown();
    });
    it('tags async database span with db.slow_query when threshold exceeded', async () => {
        let capturedSpan = null;
        const result = await withDbSpan({
            system: 'postgresql',
            operation: 'SELECT',
            table: 'large_audit_log',
            slowQueryThresholdMs: 10,
        }, async (span) => {
            capturedSpan = span;
            await new Promise((resolve) => setTimeout(resolve, 20));
            return { count: 50000 };
        });
        assert.equal(result.count, 50000);
        assert.ok(capturedSpan);
        assert.equal(capturedSpan.attributes['db.slow_query'], true);
        assert.equal(capturedSpan.attributes['db.slow_query_threshold_ms'], 10);
    });
    it('does NOT tag fast async query with db.slow_query', async () => {
        let capturedSpan = null;
        const result = await withDbSpan({
            system: 'postgresql',
            operation: 'SELECT',
            table: 'users',
            slowQueryThresholdMs: 100,
        }, async (span) => {
            capturedSpan = span;
            return [{ id: 1 }];
        });
        assert.equal(result.length, 1);
        assert.ok(capturedSpan);
        assert.equal(capturedSpan.attributes['db.slow_query'], undefined);
    });
    it('tags sync database span when threshold exceeded', () => {
        let capturedSpan = null;
        const result = withDbSpanSync({
            system: 'redis',
            operation: 'GET',
            slowQueryThresholdMs: 5,
        }, (span) => {
            capturedSpan = span;
            // Simulate busy sync loop
            const start = Date.now();
            while (Date.now() - start < 10) {
                // busy wait
            }
            return 'cached_val';
        });
        assert.equal(result, 'cached_val');
        assert.ok(capturedSpan);
        assert.equal(capturedSpan.attributes['db.slow_query'], true);
        assert.equal(capturedSpan.attributes['db.slow_query_threshold_ms'], 5);
    });
    it('preserves slow query tagging even if query throws an error', async () => {
        let capturedSpan = null;
        await assert.rejects(async () => {
            await withDbSpan({
                system: 'mysql',
                operation: 'UPDATE',
                table: 'accounts',
                slowQueryThresholdMs: 10,
            }, async (span) => {
                capturedSpan = span;
                await new Promise((resolve) => setTimeout(resolve, 15));
                throw new Error('Lock wait timeout exceeded');
            });
        }, (err) => {
            assert.equal(err.message, 'Lock wait timeout exceeded');
            return true;
        });
        assert.ok(capturedSpan);
        assert.equal(capturedSpan.attributes['db.slow_query'], true);
    });
    it('exposes withDbSpanSync on Pulse facade object', () => {
        assert.equal(typeof Pulse.withDbSpanSync, 'function');
    });
});
