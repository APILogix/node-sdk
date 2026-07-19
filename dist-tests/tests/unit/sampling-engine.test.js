/**
 * SamplingEngine unit tests.
 *
 * Validates:
 *   - FNV-1a 32-bit hash determinism and distribution.
 *   - Global per-event-type sampling rates (traces, requests, errors,
 *     profiles, replays).
 *   - Per-route, per-event-type overrides with longest-prefix-match.
 *   - Edge cases: rate 0 (always drop), rate 1 (always sample).
 *   - Config hot-swap.
 *
 * The v3 schema introduces `RouteSamplingRates` — every route entry can
 * carry independent rates per event type. A missing event-type key inside
 * a route falls through to the global rate.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { SamplingEngine } from '../../src/core/sampling-engine.js';
const baseSamplingConfig = {
    traces: 0.5,
    requests: 1.0,
    errors: 1.0,
    profiles: 0.02,
    replays: 0,
    metrics: 1.0,
    routes: {
        '/health': { traces: 0, requests: 0 },
        '/metrics': { traces: 0, requests: 0 },
        '/payments': { traces: 1.0, requests: 1.0 },
        '/auth/login': { traces: 0.5, requests: 1.0 },
        '/api/users': { traces: 0.3 },
        '/api/users/premium': { traces: 0.9 },
    },
};
describe('SamplingEngine', () => {
    let engine;
    beforeEach(() => {
        engine = SamplingEngine.initialize(baseSamplingConfig);
    });
    afterEach(() => {
        SamplingEngine.reset();
    });
    describe('FNV-1a Hash', () => {
        it('produces deterministic hash for same input', () => {
            assert.equal(SamplingEngine.fnv1a32('abc123'), SamplingEngine.fnv1a32('abc123'));
        });
        it('produces different hashes for different inputs', () => {
            assert.notEqual(SamplingEngine.fnv1a32('trace-id-1'), SamplingEngine.fnv1a32('trace-id-2'));
        });
        it('produces unsigned 32-bit integer', () => {
            for (const input of ['test', 'abc', '12345', 'very-long-string']) {
                const hash = SamplingEngine.fnv1a32(input);
                assert.ok(hash >= 0);
                assert.ok(hash <= 0xffffffff);
            }
        });
        it('has reasonable distribution', () => {
            const buckets = new Array(10).fill(0);
            for (let i = 0; i < 10_000; i++) {
                const hash = SamplingEngine.fnv1a32(`trace-${i}`);
                const bucket = Math.floor((hash / 0x100000000) * 10);
                buckets[Math.min(bucket, 9)]++;
            }
            for (let i = 0; i < 10; i++) {
                assert.ok(buckets[i] > 600, `bucket ${i}: ${buckets[i]}`);
                assert.ok(buckets[i] < 1400, `bucket ${i}: ${buckets[i]}`);
            }
        });
    });
    describe('Global Rates', () => {
        it('always samples errors (rate 1.0)', () => {
            for (let i = 0; i < 100; i++) {
                const decision = engine.shouldSampleError(`error-${i}`);
                assert.equal(decision.sampled, true);
                assert.equal(decision.reason, 'always_sample');
            }
        });
        it('never samples replays (rate 0)', () => {
            for (let i = 0; i < 100; i++) {
                const decision = engine.shouldSampleReplay(`session-${i}`);
                assert.equal(decision.sampled, false);
                assert.equal(decision.reason, 'always_drop');
            }
        });
        it('samples traces at the configured rate', () => {
            let sampled = 0;
            const total = 10_000;
            for (let i = 0; i < total; i++) {
                if (engine.shouldSampleTrace(`trace-${i}`).sampled)
                    sampled++;
            }
            const rate = sampled / total;
            assert.ok(rate > 0.4 && rate < 0.6, `rate=${rate}`);
        });
        it('produces deterministic decisions per id', () => {
            const id = 'deterministic-trace';
            assert.equal(engine.shouldSampleTrace(id).sampled, engine.shouldSampleTrace(id).sampled);
        });
        it('has shouldSampleRequest as separate API', () => {
            // requests global rate is 1.0 so every id should sample
            for (let i = 0; i < 50; i++) {
                assert.equal(engine.shouldSampleRequest(`req-${i}`).sampled, true);
            }
        });
    });
    describe('Per-Route Overrides', () => {
        it('drops /health for both traces and requests', () => {
            for (let i = 0; i < 50; i++) {
                assert.equal(engine.shouldSampleTrace(`t-${i}`, '/health').sampled, false);
                assert.equal(engine.shouldSampleRequest(`r-${i}`, '/health').sampled, false);
            }
        });
        it('always samples /payments for both traces and requests', () => {
            for (let i = 0; i < 50; i++) {
                assert.equal(engine.shouldSampleTrace(`t-${i}`, '/payments').sampled, true);
                assert.equal(engine.shouldSampleRequest(`r-${i}`, '/payments').sampled, true);
            }
        });
        it('uses longest prefix match', () => {
            // /api/users/premium has traces:0.9, /api/users has traces:0.3 — premium wins
            let sampled = 0;
            const total = 5_000;
            for (let i = 0; i < total; i++) {
                const decision = engine.shouldSampleTrace(`trace-${i}`, '/api/users/premium');
                if (decision.sampled)
                    sampled++;
                assert.equal(decision.reason, 'route_override');
            }
            const rate = sampled / total;
            assert.ok(rate > 0.83 && rate < 0.97, `rate=${rate}`);
        });
        it('falls back to global rate when route entry has no event-type key', () => {
            // /api/users has only `traces`; requests should fall through to the
            // global rate (which is 1.0 — so the reason resolves to
            // `always_sample`, not `global_rate`, but the path is the same).
            for (let i = 0; i < 50; i++) {
                const decision = engine.shouldSampleRequest(`req-${i}`, '/api/users');
                assert.equal(decision.sampled, true);
                assert.ok(decision.reason === 'global_rate' || decision.reason === 'always_sample', `unexpected reason: ${decision.reason}`);
            }
        });
        it('falls back to global rate for unknown routes', () => {
            let sampled = 0;
            const total = 5_000;
            for (let i = 0; i < total; i++) {
                const decision = engine.shouldSampleTrace(`trace-${i}`, '/unknown/path');
                if (decision.sampled)
                    sampled++;
                assert.equal(decision.reason, 'global_rate');
            }
            const rate = sampled / total;
            assert.ok(rate > 0.4 && rate < 0.6, `rate=${rate}`);
        });
    });
    describe('Config Change', () => {
        it('hot-swaps sampling config', () => {
            // Before: /health is 0
            assert.equal(engine.shouldSampleTrace('test', '/health').sampled, false);
            engine.handleConfigChange({}, {
                sampling: {
                    traces: 0.5,
                    requests: 1.0,
                    errors: 1.0,
                    profiles: 0.02,
                    replays: 0,
                    metrics: 1.0,
                    routes: { '/health': { traces: 1.0 } },
                },
            });
            assert.equal(engine.shouldSampleTrace('test', '/health').sampled, true);
        });
    });
});
