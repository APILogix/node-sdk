import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { init, shutdown, trace, wrap, Pulse, getTraceId, getSpanId, startSpan, } from '../../src/index.js';
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
describe('Pulse SDK Developer Function Decorators & Facade Parity', () => {
    beforeEach(async () => {
        setupMockFetch();
        await init({
            apiKey: 'test-key',
        });
    });
    afterEach(async () => {
        globalThis.fetch = originalFetch;
        await shutdown();
    });
    it('Pulse.wrap wraps an async function, preserving arguments, return value, and trace context', async () => {
        let capturedTraceId;
        const slowCalculation = Pulse.wrap('calc.multiply', async (a, b) => {
            capturedTraceId = getTraceId();
            return a * b;
        });
        const rootSpan = startSpan('root.job');
        const result = await slowCalculation(6, 7);
        rootSpan.end();
        assert.equal(result, 42);
        assert.ok(capturedTraceId, 'Expected function inside wrap to execute in an active trace context');
        assert.equal(slowCalculation.name, 'pulseWrapped_calc.multiply');
        assert.equal(slowCalculation.length, 2);
    });
    it('Pulse.wrap wraps a synchronous function and preserves this context', () => {
        class Calculator {
            factor = 10;
            multiply = Pulse.wrap('calc.sync', function (n) {
                return n * this.factor;
            });
        }
        const calc = new Calculator();
        const result = calc.multiply(5);
        assert.equal(result, 50);
    });
    it('Pulse.wrap re-throws errors, preserves original error, and marks span as error', async () => {
        const faultyOperation = Pulse.wrap('calc.faulty', async () => {
            throw new Error('Database connection failed');
        });
        await assert.rejects(async () => {
            await faultyOperation();
        }, (err) => {
            assert.equal(err.message, 'Database connection failed');
            return true;
        });
    });
    it('Pulse.trace handles synchronous callbacks seamlessly', () => {
        let spanExecuted = false;
        const output = Pulse.trace('sync.hash', (span) => {
            spanExecuted = true;
            span.setAttribute('crypto.algo', 'sha256');
            return 'hash_12345';
        });
        assert.equal(spanExecuted, true);
        assert.equal(output, 'hash_12345');
    });
    it('Pulse.trace handles asynchronous callbacks seamlessly', async () => {
        const output = await Pulse.trace('async.fetch', async (span) => {
            span.setAttribute('fetch.target', 'user_profile');
            return { id: 101, name: 'Alice' };
        });
        assert.deepEqual(output, { id: 101, name: 'Alice' });
    });
    it('Pulse facade namespace exposes all required APM methods', () => {
        assert.equal(typeof Pulse.wrap, 'function');
        assert.equal(typeof Pulse.trace, 'function');
        assert.equal(typeof Pulse.withSpan, 'function');
        assert.equal(typeof Pulse.withSpanSync, 'function');
        assert.equal(typeof Pulse.withBackgroundSpan, 'function');
        assert.equal(typeof Pulse.startBackgroundSpan, 'function');
        assert.equal(typeof Pulse.incrementCounter, 'function');
        assert.equal(typeof Pulse.setGauge, 'function');
        assert.equal(typeof Pulse.recordHistogram, 'function');
        assert.equal(typeof Pulse.addUpDownCounter, 'function');
    });
    it('Pulse.wrap and trace fail-open when uninitialized', async () => {
        await shutdown(); // Shut down SDK completely
        const uninitializedWrapped = Pulse.wrap('uninit.test', (x) => x + 1);
        const result = uninitializedWrapped(99);
        assert.equal(result, 100);
        const traceResult = await Pulse.trace('uninit.async', async () => 'fallback_ok');
        assert.equal(traceResult, 'fallback_ok');
    });
});
