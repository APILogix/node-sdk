import { describe, it, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { trace } from '@opentelemetry/api';
import { init, shutdown, captureError, withSpan } from '../../src/index.js';
import { client } from '../../src/core/client.js';
import { TEST_REMOTE_CONFIG } from '../fixtures/remote-config.js';
describe('Trace/Span Error Correlation - Automated Scenarios', () => {
    let capturedEvents = [];
    const originalFetch = globalThis.fetch;
    beforeEach(async () => {
        delete process.env.SDK_BASE_URL;
        delete process.env.PULSE_BASE_URL;
        capturedEvents = [];
        // Mock fetch so SDK init succeeds without network calls
        globalThis.fetch = (async (input) => {
            const url = typeof input === 'string' ? input : input.toString();
            if (url.includes('/v1/init')) {
                const activeConfig = {
                    ...TEST_REMOTE_CONFIG,
                    features: {
                        ...TEST_REMOTE_CONFIG.features,
                        errors: true,
                        tracing: true,
                        crons: true,
                    },
                    sampling: {
                        ...TEST_REMOTE_CONFIG.sampling,
                        errors: 1,
                        traces: 1,
                    },
                    entitlements: {
                        ...TEST_REMOTE_CONFIG.entitlements,
                        customSpans: true,
                        tracing: true,
                        errors: true,
                    },
                };
                return new Response(JSON.stringify({
                    success: true,
                    projectId: activeConfig.sdk.projectId,
                    environment: activeConfig.sdk.environment,
                    release: activeConfig.sdk.release,
                    config: activeConfig,
                }), { status: 200, headers: { 'content-type': 'application/json' } });
            }
            return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
        });
        // Initialize SDK with mock endpoint
        await init({
            apiKey: 'pv_test_key_1234567890',
            debug: false,
        });
        // Register test event processor to capture processed events
        client.registerEventProcessor((event) => {
            if (event.type === 'error') {
                capturedEvents.push(event);
            }
            return event;
        });
    });
    afterEach(async () => {
        await shutdown();
        globalThis.fetch = originalFetch;
    });
    it('1. captureError() inside withSpan() -> traceId and spanId present', async () => {
        let expectedTraceId;
        let expectedSpanId;
        await withSpan('test-manual-span', (span) => {
            expectedTraceId = span.spanContext().traceId;
            expectedSpanId = span.spanContext().spanId;
            captureError(new Error('error inside withSpan'));
        });
        await new Promise(r => setTimeout(r, 50));
        assert.strictEqual(capturedEvents.length, 1);
        const event = capturedEvents[0];
        assert.strictEqual(event.message, 'error inside withSpan');
        assert.ok(event.traceId, 'traceId should be present');
        assert.ok(event.spanId, 'spanId should be present');
        assert.strictEqual(event.traceId, expectedTraceId);
        assert.strictEqual(event.spanId, expectedSpanId);
    });
    it('2. captureError() inside an instrumented BullMQ worker (OTel CONSUMER span) -> traceId present', async () => {
        const tracer = trace.getTracer('bullmq-mock');
        let expectedTraceId;
        await tracer.startActiveSpan('bullmq.processJob', async (span) => {
            expectedTraceId = span.spanContext().traceId;
            captureError(new Error('job failed'));
            span.end();
        });
        await new Promise(r => setTimeout(r, 50));
        assert.strictEqual(capturedEvents.length, 1);
        const event = capturedEvents[0];
        assert.strictEqual(event.message, 'job failed');
        assert.ok(event.traceId, 'traceId should be present for BullMQ worker');
        assert.strictEqual(event.traceId, expectedTraceId);
    });
    it('3. captureError() during startup / outside span -> traceId absent (undefined)', async () => {
        captureError(new Error('startup failure'));
        await new Promise(r => setTimeout(r, 50));
        assert.strictEqual(capturedEvents.length, 1);
        const event = capturedEvents[0];
        assert.strictEqual(event.message, 'startup failure');
        assert.strictEqual(event.traceId, undefined, 'traceId should be undefined outside any span scope');
        assert.strictEqual(event.spanId, undefined, 'spanId should be undefined outside any span scope');
    });
    it('4. captureError() inside a cron job without a span -> traceId absent', async () => {
        captureError(new Error('cron job failure'));
        await new Promise(r => setTimeout(r, 50));
        assert.strictEqual(capturedEvents.length, 1);
        const event = capturedEvents[0];
        assert.strictEqual(event.message, 'cron job failure');
        assert.strictEqual(event.traceId, undefined, 'traceId should be undefined for cron job without span');
    });
    it('5. captureError() after await within an active span -> traceId still present', async () => {
        let expectedTraceId;
        await withSpan('async-worker-span', async (span) => {
            expectedTraceId = span.spanContext().traceId;
            await new Promise(res => setTimeout(res, 20));
            captureError(new Error('error after await'));
        });
        await new Promise(r => setTimeout(r, 50));
        assert.strictEqual(capturedEvents.length, 1);
        const event = capturedEvents[0];
        assert.strictEqual(event.message, 'error after await');
        assert.ok(event.traceId, 'traceId should remain present after await');
        assert.strictEqual(event.traceId, expectedTraceId);
    });
    it('6. captureError() inside a setTimeout callback within a span -> test runtime preservation', async () => {
        let expectedTraceId;
        await withSpan('timer-span', async (span) => {
            expectedTraceId = span.spanContext().traceId;
            await new Promise((resolve) => {
                setTimeout(() => {
                    captureError(new Error('error inside setTimeout'));
                    resolve();
                }, 20);
            });
        });
        await new Promise(r => setTimeout(r, 50));
        assert.strictEqual(capturedEvents.length, 1);
        const event = capturedEvents[0];
        assert.strictEqual(event.message, 'error inside setTimeout');
        assert.ok(event.traceId, 'traceId is preserved in setTimeout callbacks in Node.js');
        assert.strictEqual(event.traceId, expectedTraceId);
    });
    it('7. captureError() inside Express route context -> traceId present', async () => {
        const tracer = trace.getTracer('@opentelemetry/instrumentation-express');
        let expectedTraceId;
        await tracer.startActiveSpan('GET /api/users', async (span) => {
            expectedTraceId = span.spanContext().traceId;
            captureError(new Error('express route handler error'));
            span.end();
        });
        await new Promise(r => setTimeout(r, 50));
        assert.strictEqual(capturedEvents.length, 1);
        const event = capturedEvents[0];
        assert.strictEqual(event.message, 'express route handler error');
        assert.ok(event.traceId, 'traceId must be present in Express route context');
        assert.strictEqual(event.traceId, expectedTraceId);
    });
});
