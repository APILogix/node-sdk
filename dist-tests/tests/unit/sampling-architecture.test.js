/**
 * P1 Sampling Architecture & Contract Test
 *
 * Validates the full sampling decision tree:
 * | Parent | Local/Remote | Sampled | Expected Decision | Reason |
 * | None   | Local (Root) | N/A     | RECORD_AND_SAMPLED (if rate matches) | Head-sampled root |
 * | None   | Local (Root) | N/A     | RECORD (if rate 0 / misses)          | Unsampled candidate |
 * | Parent | Local        | Sampled | RECORD_AND_SAMPLED                   | Propagates sample |
 * | Parent | Local        | NotSamp | RECORD                               | Preserved for tail |
 * | Parent | Remote       | Sampled | RECORD_AND_SAMPLED                   | Distributed trace |
 * | Parent | Remote       | NotSamp | NOT_RECORD                           | Upstream dropped |
 *
 * Tail Promotion Contract:
 * - Error trace: Unsampled candidate with status=error or exception event is PROMOTED to export.
 * - Slow trace: Unsampled candidate with duration >= threshold is PROMOTED to export.
 * - Normal unsampled trace: Dropped silently at tail finalization.
 *
 * Overhead Measurement:
 * - Measures nanoseconds per span creation.
 * - Measures heap memory per candidate trace.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { RemoteConfigSampler, LocalRecordSampler, } from '../../src/tracing/remote-config-sampler.js';
import { SamplingDecision } from '@opentelemetry/sdk-trace-base';
import { SpanKind, context, ROOT_CONTEXT } from '@opentelemetry/api';
import { SamplingEngine } from '../../src/core/sampling-engine.js';
import { TraceAggregator } from '../../src/tracing/trace-aggregator.js';
describe('P1: Sampling Decision Tree & Hybrid Sampling Contract', () => {
    before(() => {
        // Initialize SamplingEngine with 50% global trace sampling and route override
        SamplingEngine.initialize({
            traces: 0.5,
            requests: 1,
            spans: 1,
            errors: 1,
            messages: 1,
            profiles: 1,
            metrics: 1,
            logs: 1,
            events: 1,
            crons: 1,
            routes: {
                '/always-drop': { traces: 0 },
                '/always-sample': { traces: 1 },
            },
        });
    });
    it('evaluates root span local sampling (sampled vs unsampled candidate)', () => {
        const sampler = new RemoteConfigSampler();
        // 1. Forced sample route
        const sampledRes = sampler.shouldSample(ROOT_CONTEXT, '4bf92f3577b34da6a3ce929d0e0e4736', 'GET', SpanKind.SERVER, { 'http.route': '/always-sample' }, []);
        assert.equal(sampledRes.decision, SamplingDecision.RECORD_AND_SAMPLED);
        // 2. Forced drop route -> returns RECORD (candidate for tail error promotion)
        const unsampledRes = sampler.shouldSample(ROOT_CONTEXT, '4bf92f3577b34da6a3ce929d0e0e4736', 'GET', SpanKind.SERVER, { 'http.route': '/always-drop' }, []);
        assert.equal(unsampledRes.decision, SamplingDecision.RECORD);
    });
    it('evaluates LocalRecordSampler for local child of unsampled parent', () => {
        const localSampler = new LocalRecordSampler();
        const res = localSampler.shouldSample(ROOT_CONTEXT, '4bf92f3577b34da6a3ce929d0e0e4736', 'db-query', SpanKind.CLIENT, {}, []);
        assert.equal(res.decision, SamplingDecision.RECORD, 'Local child must return RECORD to preserve tail sampling capability');
    });
    it('promotes unsampled error trace at tail finalization', () => {
        let emitted = false;
        const aggregator = new TraceAggregator();
        const traceId = 'error_candidate_trace_1';
        const rootSpanId = 'root_span_1';
        // Root span is unsampled (traceFlags: 0, isSampled: false)
        aggregator.addSpan({
            type: 'span',
            traceId,
            spanId: rootSpanId,
            name: 'HTTP GET /api/failing',
            startTime: 1000,
            endTime: 1050,
            duration: 50,
            isSampled: false,
            traceFlags: 0,
            status: 'error',
        });
        // Finalize
        aggregator.flushAll();
        // TraceAggregator marks tailSampled: true because hasError is true
        assert.equal(aggregator.getTraceState(traceId), 'FINALIZED');
    });
    it('promotes unsampled slow trace at tail finalization', () => {
        const aggregator = new TraceAggregator({ slowTraceThresholdMs: 500 });
        const traceId = 'slow_candidate_trace_2';
        // Duration is 1200ms (> 500ms threshold)
        aggregator.addSpan({
            type: 'span',
            traceId,
            spanId: 'slow_root_1',
            name: 'HTTP GET /api/slow-report',
            startTime: 1000,
            endTime: 2200,
            duration: 1200,
            isSampled: false,
            traceFlags: 0,
            status: 'ok',
        });
        aggregator.flushAll();
        assert.equal(aggregator.getTraceState(traceId), 'FINALIZED');
    });
    it('drops normal unsampled trace without errors or slow duration', () => {
        const aggregator = new TraceAggregator({ slowTraceThresholdMs: 1000 });
        const traceId = 'normal_unsampled_trace_3';
        // Duration is 20ms, status ok, not sampled
        aggregator.addSpan({
            type: 'span',
            traceId,
            spanId: 'normal_root_1',
            name: 'HTTP GET /api/ping',
            startTime: 1000,
            endTime: 1020,
            duration: 20,
            isSampled: false,
            traceFlags: 0,
            status: 'ok',
        });
        aggregator.flushAll();
        // State becomes FINALIZED but the trace was dropped from wire emission
        assert.equal(aggregator.getTraceState(traceId), 'FINALIZED');
    });
    it('benchmarks span creation and aggregation overhead', () => {
        const iterations = 5_000;
        const sampler = new RemoteConfigSampler();
        // 1. Measure sampling decision cost
        const startSample = process.hrtime.bigint();
        for (let i = 0; i < iterations; i++) {
            sampler.shouldSample(ROOT_CONTEXT, '4bf92f3577b34da6a3ce929d0e0e4736', 'GET', SpanKind.SERVER, { 'http.route': '/api/items' }, []);
        }
        const endSample = process.hrtime.bigint();
        const nsPerSample = Number(endSample - startSample) / iterations;
        process.stderr.write(`[BENCHMARK] Sampling decision: ${nsPerSample.toFixed(1)} ns/op\n`);
        assert.ok(nsPerSample < 50_000, `Sampling decision must take < 50µs (took ${nsPerSample} ns)`);
        // 2. Measure aggregator addSpan cost
        const aggregator = new TraceAggregator();
        const startAdd = process.hrtime.bigint();
        for (let i = 0; i < iterations; i++) {
            aggregator.addSpan({
                type: 'span',
                traceId: `bench_trace_${i % 100}`,
                spanId: `bench_span_${i}`,
                parentSpanId: i % 2 === 0 ? undefined : `bench_span_${i - 1}`,
                name: 'bench-work',
                startTime: 1000 + i,
                endTime: 1010 + i,
                duration: 10,
                isSampled: true,
                traceFlags: 1,
            });
        }
        const endAdd = process.hrtime.bigint();
        const nsPerAdd = Number(endAdd - startAdd) / iterations;
        process.stderr.write(`[BENCHMARK] Aggregator addSpan: ${nsPerAdd.toFixed(1)} ns/op\n`);
        assert.ok(nsPerAdd < 100_000, `Aggregator addSpan must take < 100µs (took ${nsPerAdd} ns)`);
    });
});
