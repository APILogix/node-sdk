import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { TraceAggregator, resetTraceAggregator } from '../../src/tracing/trace-aggregator.js';
import { processEvent } from '../../src/core/event-pipeline.js';
describe('TraceAggregator State Machine & Reliability Contract', () => {
    let emittedEvents = [];
    beforeEach(() => {
        resetTraceAggregator();
        emittedEvents = [];
        // Intercept processEvent by mocking or using emitted events
    });
    afterEach(() => {
        resetTraceAggregator();
    });
    it('1. State machine transitions through OPEN -> ROOT_ENDED -> QUIESCING -> FINALIZED', async () => {
        const aggregator = new TraceAggregator({
            gracePeriodMs: 30,
            maxFinalizationDelayMs: 150,
        });
        const traceId = 'trace-sm-1234567890abcdef12345678';
        const rootSpanId = 'root-span-0001';
        const childSpanId = 'child-span-0002';
        // Span starts -> state OPEN, activeSpanCount = 1
        aggregator.onSpanStart(traceId, rootSpanId);
        assert.equal(aggregator.getTraceState(traceId), 'OPEN');
        // Child span starts -> activeSpanCount = 2
        aggregator.onSpanStart(traceId, childSpanId);
        assert.equal(aggregator.getTraceState(traceId), 'OPEN');
        // Root span ends -> activeSpanCount = 1, state ROOT_ENDED
        aggregator.addSpan({
            traceId,
            spanId: rootSpanId,
            name: 'HTTP GET /api/data',
            startTime: 1000,
            endTime: 1050,
            duration: 50,
            isSampled: true,
        });
        aggregator.onSpanEnd(traceId, rootSpanId, true);
        assert.equal(aggregator.getTraceState(traceId), 'ROOT_ENDED');
        // Child span ends -> activeSpanCount = 0, state QUIESCING
        aggregator.addSpan({
            traceId,
            spanId: childSpanId,
            parentSpanId: rootSpanId,
            name: 'DB SELECT',
            startTime: 1010,
            endTime: 1040,
            duration: 30,
            isSampled: true,
        });
        aggregator.onSpanEnd(traceId, childSpanId, false);
        assert.equal(aggregator.getTraceState(traceId), 'QUIESCING');
        // Wait for quiet period
        await new Promise(resolve => setTimeout(resolve, 50));
        // State is FINALIZED
        assert.equal(aggregator.getTraceState(traceId), 'FINALIZED');
        assert.equal(aggregator.isFinalized(traceId), true);
        assert.equal(aggregator.pendingCount, 0);
    });
    it('2. New span arriving during QUIESCING aborts quiet period and returns to active state', async () => {
        const aggregator = new TraceAggregator({
            gracePeriodMs: 40,
            maxFinalizationDelayMs: 200,
        });
        const traceId = 'trace-quiesce-cancel-1234567890ab';
        const rootSpanId = 'root-001';
        const child1Id = 'child-001';
        const child2Id = 'child-002';
        aggregator.onSpanStart(traceId, rootSpanId);
        aggregator.onSpanStart(traceId, child1Id);
        aggregator.onSpanEnd(traceId, rootSpanId, true);
        aggregator.onSpanEnd(traceId, child1Id, false);
        // At this point activeSpanCount = 0, state is QUIESCING
        assert.equal(aggregator.getTraceState(traceId), 'QUIESCING');
        // Before quiet timer expires, a new child span starts!
        aggregator.onSpanStart(traceId, child2Id);
        // State must revert from QUIESCING to ROOT_ENDED (activeSpans = 1)
        assert.equal(aggregator.getTraceState(traceId), 'ROOT_ENDED');
        // Child2 ends -> back to QUIESCING
        aggregator.onSpanEnd(traceId, child2Id, false);
        assert.equal(aggregator.getTraceState(traceId), 'QUIESCING');
        // Wait for quiet timer to fire
        await new Promise(resolve => setTimeout(resolve, 60));
        assert.equal(aggregator.getTraceState(traceId), 'FINALIZED');
    });
    it('3. Explicit late-span policy & No trace resurrection once FINALIZED', async () => {
        const aggregator = new TraceAggregator({
            gracePeriodMs: 20,
            maxFinalizationDelayMs: 100,
        });
        const traceId = 'trace-no-resurrect-999999999999';
        const rootSpanId = 'root-final-001';
        aggregator.onSpanStart(traceId, rootSpanId);
        aggregator.addSpan({
            traceId,
            spanId: rootSpanId,
            name: 'HTTP POST /submit',
            startTime: 2000,
            endTime: 2020,
            duration: 20,
            isSampled: true,
        });
        aggregator.onSpanEnd(traceId, rootSpanId, true);
        // Wait for finalization
        await new Promise(resolve => setTimeout(resolve, 40));
        assert.equal(aggregator.isFinalized(traceId), true);
        assert.equal(aggregator.pendingCount, 0);
        // Case B: Late asynchronous work starts 400ms after finalization
        const lateSpanId = 'late-background-job';
        aggregator.onSpanStart(traceId, lateSpanId);
        // MUST NOT resurrect the finalized trace!
        assert.equal(aggregator.pendingCount, 0, 'Late span start must not resurrect pending trace');
        assert.equal(aggregator.isFinalized(traceId), true);
        // Calling addSpan with late span must also be dropped
        aggregator.addSpan({
            traceId,
            spanId: lateSpanId,
            parentSpanId: rootSpanId,
            name: 'Late Async Task',
            startTime: 2500,
            endTime: 2550,
            duration: 50,
            isSampled: true,
        });
        assert.equal(aggregator.pendingCount, 0, 'Late span add must not resurrect pending trace');
    });
    it('4. Sampling contract: Unsampled trace promotes the ENTIRE retained trace tree on error', async () => {
        const emitted = [];
        const aggregator = new TraceAggregator({
            gracePeriodMs: 20,
            maxFinalizationDelayMs: 100,
        });
        const traceId = 'trace-tail-error-1111222233334444';
        const rootSpanId = 'root-unsampled';
        const childDbId = 'child-db';
        const childCacheId = 'child-cache';
        aggregator.onSpanStart(traceId, rootSpanId);
        aggregator.onSpanStart(traceId, childDbId);
        aggregator.onSpanStart(traceId, childCacheId);
        // Add root (unsampled at head)
        aggregator.addSpan({
            traceId,
            spanId: rootSpanId,
            name: 'HTTP GET /api/orders',
            startTime: 1000,
            endTime: 1080,
            duration: 80,
            isSampled: false,
            status: 'ok',
        });
        // Add child 1 (cache - ok)
        aggregator.addSpan({
            traceId,
            spanId: childCacheId,
            parentSpanId: rootSpanId,
            name: 'Redis GET order:123',
            startTime: 1005,
            endTime: 1015,
            duration: 10,
            isSampled: false,
            status: 'ok',
        });
        // Add child 2 (database - ERROR!)
        aggregator.addSpan({
            traceId,
            spanId: childDbId,
            parentSpanId: rootSpanId,
            name: 'pg.query SELECT * FROM orders',
            startTime: 1020,
            endTime: 1070,
            duration: 50,
            isSampled: false,
            status: 'error',
            statusMessage: 'connection timeout',
        });
        aggregator.onSpanEnd(traceId, childCacheId, false);
        aggregator.onSpanEnd(traceId, childDbId, false);
        aggregator.onSpanEnd(traceId, rootSpanId, true);
        // Wait for quiescing and finalization
        await new Promise(resolve => setTimeout(resolve, 40));
        assert.equal(aggregator.isFinalized(traceId), true);
    });
    it('5. Hard finalization deadline: Hanging async child span does not leak trace indefinitely', async () => {
        const aggregator = new TraceAggregator({
            gracePeriodMs: 20,
            maxFinalizationDelayMs: 50, // 50ms hard safety bound
        });
        const traceId = 'trace-hard-deadline-1234567890';
        const rootSpanId = 'root-dead-001';
        const hangingChildId = 'child-hangs-forever';
        aggregator.onSpanStart(traceId, rootSpanId);
        aggregator.onSpanStart(traceId, hangingChildId);
        aggregator.addSpan({
            traceId,
            spanId: rootSpanId,
            name: 'HTTP GET /api/async',
            startTime: 1000,
            endTime: 1020,
            duration: 20,
            isSampled: true,
        });
        aggregator.onSpanEnd(traceId, rootSpanId, true);
        // Child NEVER ends (activeSpanCount remains 1)
        assert.equal(aggregator.getTraceState(traceId), 'ROOT_ENDED');
        // Wait 70ms (> 50ms hard safety deadline)
        await new Promise(resolve => setTimeout(resolve, 70));
        // Trace MUST be forcibly finalized
        assert.equal(aggregator.isFinalized(traceId), true);
        assert.equal(aggregator.pendingCount, 0);
    });
});
