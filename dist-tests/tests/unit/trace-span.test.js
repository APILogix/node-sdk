import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Pulse } from '../../src/index.js'; // Adjust import path as needed
/**
 * Verifies that child spans inherit the same traceId as the root span.
 */
describe('Pulse SDK Trace/Span Consistency', () => {
    afterEach(async () => {
        // Ensure SDK is shut down after each test to avoid side‑effects.
        await Pulse.shutdown();
    });
    it('root and child spans share traceId', async () => {
        // Initialize the SDK with a no‑op exporter to avoid network calls.
        await Pulse.init({
            apiKey: 'test-key',
            // Provide a dummy transport that just resolves.
            transport: { send: async () => { } },
        });
        const rootSpan = Pulse.startSpan('root');
        const rootTraceId = rootSpan.spanContext().traceId;
        const childSpan = Pulse.startSpan('child');
        const childTraceId = childSpan.spanContext().traceId;
        // Both spans should report the same traceId.
        assert.strictEqual(childTraceId, rootTraceId, 'Child span traceId differs from root');
        childSpan.end();
        rootSpan.end();
    });
});
