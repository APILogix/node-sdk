/**
 * SamplingEngine Unit Tests
 *
 * Validates:
 * - FNV-1a 32-bit hash determinism and distribution
 * - Global trace/error/profile/replay sampling rates
 * - Per-route overrides with longest-prefix-match
 * - Edge cases: rate 0 (always drop), rate 1 (always sample)
 * - Config hot-swap via handleConfigChange
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { SamplingEngine } from '../../src/core/sampling-engine.js'

const baseSamplingConfig = {
  traces: 0.5,
  errors: 1.0,
  profiles: 0.02,
  replays: 0,
  routes: {
    '/health': 0,
    '/metrics': 0,
    '/payments': 1.0,
    '/auth/login': 0.5,
    '/api/users': 0.3,
    '/api/users/premium': 0.9,
  },
}

describe('SamplingEngine', () => {
  let engine: SamplingEngine

  beforeEach(() => {
    engine = SamplingEngine.initialize(baseSamplingConfig)
  })

  afterEach(() => {
    SamplingEngine.reset()
  })

  // ─── FNV-1a Determinism ─────────────────────────────────────────────────

  describe('FNV-1a Hash', () => {
    it('should produce deterministic hash for same input', () => {
      const hash1 = SamplingEngine.fnv1a32('abc123')
      const hash2 = SamplingEngine.fnv1a32('abc123')
      assert.equal(hash1, hash2)
    })

    it('should produce different hashes for different inputs', () => {
      const hash1 = SamplingEngine.fnv1a32('trace-id-1')
      const hash2 = SamplingEngine.fnv1a32('trace-id-2')
      assert.notEqual(hash1, hash2)
    })

    it('should produce unsigned 32-bit integer', () => {
      for (const input of ['test', 'abc', '12345', 'very-long-string-for-testing']) {
        const hash = SamplingEngine.fnv1a32(input)
        assert.ok(hash >= 0, `Hash should be non-negative: ${hash}`)
        assert.ok(hash <= 0xFFFFFFFF, `Hash should be <= 2^32: ${hash}`)
      }
    })

    it('should have reasonable distribution', () => {
      // Generate 10k hashes and check they're spread across the range
      const buckets = new Array(10).fill(0)
      for (let i = 0; i < 10000; i++) {
        const hash = SamplingEngine.fnv1a32(`trace-${i}`)
        const normalized = hash / 0x100000000
        const bucket = Math.floor(normalized * 10)
        buckets[Math.min(bucket, 9)]++
      }

      // Each bucket should have roughly 1000 (±40%) items
      for (let i = 0; i < 10; i++) {
        assert.ok(buckets[i]! > 600, `Bucket ${i} has too few items: ${buckets[i]}`)
        assert.ok(buckets[i]! < 1400, `Bucket ${i} has too many items: ${buckets[i]}`)
      }
    })
  })

  // ─── Global Sampling Rates ──────────────────────────────────────────────

  describe('Global Sampling Rates', () => {
    it('should always sample errors when rate is 1.0', () => {
      for (let i = 0; i < 100; i++) {
        const decision = engine.shouldSampleError(`error-${i}`)
        assert.equal(decision.sampled, true)
        assert.equal(decision.rate, 1)
        assert.equal(decision.reason, 'always_sample')
      }
    })

    it('should never sample replays when rate is 0', () => {
      for (let i = 0; i < 100; i++) {
        const decision = engine.shouldSampleReplay(`session-${i}`)
        assert.equal(decision.sampled, false)
        assert.equal(decision.rate, 0)
        assert.equal(decision.reason, 'always_drop')
      }
    })

    it('should sample traces at approximately the configured rate', () => {
      let sampled = 0
      const total = 10000
      for (let i = 0; i < total; i++) {
        const decision = engine.shouldSampleTrace(`trace-${i}`)
        if (decision.sampled) sampled++
      }

      const rate = sampled / total
      // With 10k samples at 50%, we expect ~5000 ± 300
      assert.ok(rate > 0.4, `Sampling rate too low: ${rate}`)
      assert.ok(rate < 0.6, `Sampling rate too high: ${rate}`)
    })

    it('should produce deterministic trace decisions', () => {
      const traceId = 'deterministic-trace-id-12345'
      const decision1 = engine.shouldSampleTrace(traceId)
      const decision2 = engine.shouldSampleTrace(traceId)
      assert.equal(decision1.sampled, decision2.sampled)
      assert.equal(decision1.rate, decision2.rate)
    })
  })

  // ─── Per-Route Overrides ────────────────────────────────────────────────

  describe('Per-Route Overrides', () => {
    it('should always drop /health route (rate 0)', () => {
      for (let i = 0; i < 100; i++) {
        const decision = engine.shouldSampleTrace(`trace-${i}`, '/health')
        assert.equal(decision.sampled, false)
        assert.equal(decision.rate, 0)
        assert.equal(decision.reason, 'always_drop')
      }
    })

    it('should always drop /metrics route (rate 0)', () => {
      const decision = engine.shouldSampleTrace('any-trace', '/metrics')
      assert.equal(decision.sampled, false)
      assert.equal(decision.reason, 'always_drop')
    })

    it('should always sample /payments route (rate 1)', () => {
      for (let i = 0; i < 100; i++) {
        const decision = engine.shouldSampleTrace(`trace-${i}`, '/payments')
        assert.equal(decision.sampled, true)
        assert.equal(decision.rate, 1)
        assert.equal(decision.reason, 'always_sample')
      }
    })

    it('should use longest prefix match for /api/users/premium', () => {
      // /api/users/premium (0.9) should win over /api/users (0.3)
      let sampled = 0
      const total = 10000
      for (let i = 0; i < total; i++) {
        const decision = engine.shouldSampleTrace(`trace-${i}`, '/api/users/premium')
        if (decision.sampled) sampled++
        assert.equal(decision.reason, 'route_override')
      }

      const rate = sampled / total
      // Should be ~90% ±5%
      assert.ok(rate > 0.83, `Rate too low for /api/users/premium: ${rate}`)
      assert.ok(rate < 0.97, `Rate too high for /api/users/premium: ${rate}`)
    })

    it('should fall back to global rate for unknown routes', () => {
      let sampled = 0
      const total = 10000
      for (let i = 0; i < total; i++) {
        const decision = engine.shouldSampleTrace(`trace-${i}`, '/unknown/path')
        if (decision.sampled) sampled++
        assert.equal(decision.reason, 'global_rate')
      }

      const rate = sampled / total
      // Should be ~50% (global traces rate)
      assert.ok(rate > 0.4, `Rate too low for unknown route: ${rate}`)
      assert.ok(rate < 0.6, `Rate too high for unknown route: ${rate}`)
    })
  })

  // ─── Config Hot-Swap ────────────────────────────────────────────────────

  describe('Config Change', () => {
    it('should update sampling rates on config change', () => {
      // Start with traces: 0.5 — /health always dropped
      const decision1 = engine.shouldSampleTrace('test-trace', '/health')
      assert.equal(decision1.sampled, false)

      // Hot-swap to /health: 1.0
      engine.handleConfigChange({} as any, {
        sampling: {
          traces: 0.5,
          errors: 1.0,
          profiles: 0.02,
          replays: 0,
          routes: { '/health': 1.0 },
        },
      } as any)

      const decision2 = engine.shouldSampleTrace('test-trace', '/health')
      assert.equal(decision2.sampled, true)
      assert.equal(decision2.rate, 1)
    })
  })

  // ─── Profile Sampling ──────────────────────────────────────────────────

  describe('Profile Sampling', () => {
    it('should sample profiles at 2% rate', () => {
      let sampled = 0
      const total = 50000
      for (let i = 0; i < total; i++) {
        const decision = engine.shouldSampleProfile(`profile-${i}`)
        if (decision.sampled) sampled++
      }

      const rate = sampled / total
      assert.ok(rate > 0.01, `Profile rate too low: ${rate}`)
      assert.ok(rate < 0.04, `Profile rate too high: ${rate}`)
    })
  })
})
