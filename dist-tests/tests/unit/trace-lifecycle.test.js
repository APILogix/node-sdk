// tests/unit/trace-lifecycle.test.ts
import { test, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { initTracer, withSpan, startSpan, shutdownTracer } from '../../src/tracing/tracer.js';
import { ProfilingSubsystem } from '../../src/subsystems/profiling-subsystem.js';
// Simple mock to capture profiling calls
const profilingCalls = { start: false, stop: false };
before(() => {
    // Mock the ProfilingSubsystem singleton
    ProfilingSubsystem.getInstance = () => ({
        startCpuProfile: (traceId, spanId) => {
            profilingCalls.start = true;
        },
        stopCpuProfile: (traceId) => {
            profilingCalls.stop = true;
        },
    });
    const minimalConfig = {
        sdk: {
            projectId: 'test-service',
            service: 'test-service',
            release: '1.0.0',
            environment: 'dev',
        },
        service: 'test-service',
        release: '1.0.0',
        environment: 'dev',
        entitlements: {
            customSpans: true,
            profiling: true,
            customMetrics: true,
            logging: true,
            crons: true,
            requestCapture: true,
            tracing: true,
            errors: true,
            metrics: true,
        },
    };
    initTracer(minimalConfig);
});
after(async () => {
    await shutdownTracer();
});
test('root and child spans share the same traceId and profiling occurs only on root span', async () => {
    await withSpan('root-span', async (rootSpan) => {
        const rootTraceId = rootSpan.traceId;
        const childSpan = startSpan('child-span');
        const childTraceId = childSpan.traceId;
        assert.strictEqual(rootTraceId, childTraceId);
        assert.ok(profilingCalls.start);
        assert.ok(!profilingCalls.stop);
        childSpan.end();
    });
    assert.ok(profilingCalls.stop);
});
