import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { init, shutdown, startSpan } from '../../src/index.js';
/**
 * Verifies that child spans inherit the same traceId as the root span.
 *
 * The SDK exposes individual named exports (no `Pulse` namespace), so we
 * import `init`, `shutdown`, and `startSpan` directly.
 */
describe('Pulse SDK Trace/Span Consistency', () => {
    afterEach(async () => {
        // Ensure SDK is shut down after each test to avoid side-effects.
        await shutdown();
    });
    it('root and child spans share traceId', async () => {
        // Initialize the SDK against a non-routable host so init never tries
        // to reach a real backend; the offline-fallback config kicks in.
        await init({
            apiKey: 'test-key',
            service: 'pulse-trace-span-test',
            environment: 'test',
            release: '0.0.0-test',
            baseUrl: 'http://127.0.0.1:1',
        });
        const rootSpan = startSpan('root');
        const rootTraceId = rootSpan.spanContext().traceId;
        const childSpan = startSpan('child');
        const childTraceId = childSpan.spanContext().traceId;
        assert.strictEqual(childTraceId, rootTraceId, 'Child span traceId differs from root');
        childSpan.end();
        rootSpan.end();
    });
});
