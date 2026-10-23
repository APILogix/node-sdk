import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { init, shutdown, trace, wrap, LynkTrace, getTraceId, getSpanId, startSpan, } from '../../src/index.js';
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
describe('LynkTrace SDK Developer Function Decorators & Facade Parity', () => {
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
    it('LynkTrace.wrap wraps an async function, preserving arguments, return value, and trace context', async () => {
        let capturedTraceId;
        const slowCalculation = LynkTrace.wrap('calc.multiply', async (a, b) => {
            capturedTraceId = getTraceId();
            return a * b;
        });
        const rootSpan = startSpan('root.job');
        const result = await slowCalculation(6, 7);
        rootSpan.end();
        assert.equal(result, 42);
        assert.ok(capturedTraceId, 'Expected function inside wrap to execute in an active trace context');
        assert.ok(slowCalculation.name === 'lynktraceWrapped_calc.multiply' ||
            slowCalculation.name === 'pulseWrapped_calc.multiply');
        assert.equal(slowCalculation.length, 2);
    });
    it('LynkTrace.wrap wraps a synchronous function and preserves this context', () => {
        class Calculator {
            factor = 10;
            multiply = LynkTrace.wrap('calc.sync', function (n) {
                return n * this.factor;
            });
        }
        const calc = new Calculator();
        const result = calc.multiply(5);
        assert.equal(result, 50);
    });
    it('LynkTrace.wrap re-throws errors, preserves original error, and marks span as error', async () => {
        const faultyOperation = LynkTrace.wrap('calc.faulty', async () => {
            throw new Error('Database connection failed');
        });
        await assert.rejects(async () => {
            await faultyOperation();
        }, (err) => {
            assert.equal(err.message, 'Database connection failed');
            return true;
        });
    });
    it('LynkTrace.trace handles synchronous callbacks seamlessly', () => {
        let spanExecuted = false;
        const output = LynkTrace.trace('sync.hash', (span) => {
            spanExecuted = true;
            span.setAttribute('crypto.algo', 'sha256');
            return 'hash_12345';
        });
        assert.equal(spanExecuted, true);
        assert.equal(output, 'hash_12345');
    });
    it('LynkTrace.trace handles asynchronous callbacks seamlessly', async () => {
        const output = await LynkTrace.trace('async.fetch', async (span) => {
            span.setAttribute('fetch.target', 'user_profile');
            return { id: 101, name: 'Alice' };
        });
        assert.deepEqual(output, { id: 101, name: 'Alice' });
    });
    it('LynkTrace facade namespace exposes all required APM methods', () => {
        assert.equal(typeof LynkTrace.wrap, 'function');
        assert.equal(typeof LynkTrace.trace, 'function');
        assert.equal(typeof LynkTrace.withSpan, 'function');
        assert.equal(typeof LynkTrace.withSpanSync, 'function');
        assert.equal(typeof LynkTrace.withBackgroundSpan, 'function');
        assert.equal(typeof LynkTrace.startBackgroundSpan, 'function');
        assert.equal(typeof LynkTrace.incrementCounter, 'function');
        assert.equal(typeof LynkTrace.setGauge, 'function');
        assert.equal(typeof LynkTrace.recordHistogram, 'function');
        assert.equal(typeof LynkTrace.addUpDownCounter, 'function');
    });
    it('LynkTrace.wrap and trace fail-open when uninitialized', async () => {
        await shutdown(); // Shut down SDK completely
        const uninitializedWrapped = LynkTrace.wrap('uninit.test', (x) => x + 1);
        const result = uninitializedWrapped(99);
        assert.equal(result, 100);
        const traceResult = await LynkTrace.trace('uninit.async', async () => 'fallback_ok');
        assert.equal(traceResult, 'fallback_ok');
    });
});
