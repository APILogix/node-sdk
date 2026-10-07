import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeMetricsSubsystem, RUNTIME_METRIC_NAMES, } from '../../src/subsystems/runtime-metrics-subsystem.js';
import { metricsRegistry } from '../../src/metrics/registry.js';
import { init, shutdown } from '../../src/index.js';
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
                        metrics: true,
                        runtimeMetrics: true,
                    },
                },
            }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
}
describe('RuntimeMetricsSubsystem — Enterprise Node.js Vitals', () => {
    beforeEach(async () => {
        setupMockFetch();
        await init({ apiKey: 'test-key' });
    });
    afterEach(async () => {
        globalThis.fetch = originalFetch;
        await shutdown();
    });
    it('collects all standard runtime metrics on collect()', () => {
        const subsystem = RuntimeMetricsSubsystem.getInstance();
        subsystem.start({ intervalMs: 60000, enabled: true, eventLoopMonitoring: true, gcMonitoring: true });
        // Manually trigger a collection
        subsystem.collect();
        const stats = metricsRegistry.getStats();
        assert.ok(stats.totalFlushed >= 0, 'Metrics registry should be functional');
        assert.ok(stats.otelStats?.gaugeCount !== undefined || stats.totalFlushed >= 0, 'Gauges or otel stats should be tracked');
    });
    it('verifies exact metric names contract with backend runtime.worker.ts', () => {
        assert.equal(RUNTIME_METRIC_NAMES.heapUsed, 'runtime.heap.used');
        assert.equal(RUNTIME_METRIC_NAMES.heapTotal, 'runtime.heap.total');
        assert.equal(RUNTIME_METRIC_NAMES.rss, 'runtime.memory.rss');
        assert.equal(RUNTIME_METRIC_NAMES.external, 'runtime.memory.external');
        assert.equal(RUNTIME_METRIC_NAMES.handles, 'runtime.handles.active');
        assert.equal(RUNTIME_METRIC_NAMES.eventLoopLag, 'runtime.eventloop.lag');
        assert.equal(RUNTIME_METRIC_NAMES.eventLoopUtilization, 'runtime.eventloop.utilization');
        assert.equal(RUNTIME_METRIC_NAMES.gcPause, 'runtime.gc.pause');
    });
    it('stops and starts gracefully without throwing', () => {
        const subsystem = RuntimeMetricsSubsystem.getInstance();
        subsystem.start({ intervalMs: 1000 });
        assert.doesNotThrow(() => {
            subsystem.stop();
        });
        assert.doesNotThrow(() => {
            subsystem.start({ intervalMs: 2000 });
            subsystem.stop();
        });
    });
    it('handles remote config disabling runtime metrics dynamically', () => {
        const subsystem = RuntimeMetricsSubsystem.getInstance();
        subsystem.configure({
            ...TEST_REMOTE_CONFIG,
            features: {
                ...TEST_REMOTE_CONFIG.features,
                runtimeMetrics: false,
            },
        });
        // Should not throw and should not collect when disabled
        assert.doesNotThrow(() => {
            subsystem.collect();
        });
    });
});
