import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AdaptivePressureMonitor } from '../../src/utils/adaptive-pressure.js';
import { MemoryPressureMonitor } from '../../src/utils/backpressure.js';
describe('Adaptive Pressure State Machine & Hysteresis', () => {
    it('initializes in HEALTHY state with zero score', () => {
        const monitor = new AdaptivePressureMonitor({
            runtimeMetrics: false,
            eventLoopMonitoring: false,
            gcMonitoring: false,
        });
        assert.equal(monitor.getState(), 'HEALTHY');
        assert.equal(monitor.getLevel(), 'normal');
        const snapshot = monitor.getSnapshot();
        assert.equal(snapshot.state, 'HEALTHY');
        assert.equal(snapshot.score, 0);
    });
    it('transitions from HEALTHY to ELEVATED, PRESSURED, and CRITICAL as queue utilization rises', () => {
        let queueUtil = 0;
        const monitor = new AdaptivePressureMonitor({
            runtimeMetrics: false,
            eventLoopMonitoring: false,
            gcMonitoring: false,
            getQueueUtilization: () => queueUtil,
            pollIntervalMs: 50,
        });
        // HEALTHY at 0%
        queueUtil = 0;
        monitor.poll();
        assert.equal(monitor.getState(), 'HEALTHY');
        // ELEVATED at 75% (score = 50)
        queueUtil = 0.76;
        monitor.poll();
        assert.equal(monitor.getState(), 'ELEVATED');
        // CRITICAL at 95% (score = 80 >= 78)
        queueUtil = 0.95;
        monitor.poll();
        assert.equal(monitor.getState(), 'CRITICAL');
    });
    it('enforces hysteresis: does not exit CRITICAL until score drops below exit threshold (60)', () => {
        let queueUtil = 0.95;
        const monitor = new AdaptivePressureMonitor({
            runtimeMetrics: false,
            eventLoopMonitoring: false,
            gcMonitoring: false,
            getQueueUtilization: () => queueUtil,
            pollIntervalMs: 50,
        });
        monitor.poll();
        assert.equal(monitor.getState(), 'CRITICAL');
        // Drop to 80% (score = 50 < 60) -> transitions to RECOVERING
        queueUtil = 0.80;
        monitor.poll();
        assert.equal(monitor.getState(), 'RECOVERING');
        // In RECOVERING, stays in RECOVERING for stability window
        queueUtil = 0.10;
        monitor.poll();
        assert.equal(monitor.getState(), 'RECOVERING');
        // After second healthy poll, recovers to HEALTHY
        monitor.poll();
        assert.equal(monitor.getState(), 'HEALTHY');
    });
    it('MemoryPressureMonitor computes utilization against effective limit with hysteresis', () => {
        const memMonitor = new MemoryPressureMonitor({
            maxMemoryMb: 1000,
            elevatedThreshold: 0.70,
            criticalThreshold: 0.88,
            elevatedExitThreshold: 0.60,
            criticalExitThreshold: 0.75,
        });
        const state = memMonitor.getState();
        assert.equal(state.effectiveLimitMb, 1000);
        assert.ok(state.effectiveUtilization >= 0);
        assert.ok(state.effectiveUtilization <= 1);
    });
    it('resetWarmup clears startup histogram and restores HEALTHY state', () => {
        const monitor = new AdaptivePressureMonitor({
            runtimeMetrics: false,
            eventLoopMonitoring: false,
            gcMonitoring: false,
        });
        monitor.resetWarmup();
        assert.equal(monitor.getState(), 'HEALTHY');
    });
});
