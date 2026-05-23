/**
 * ConfigDiffer (diffConfigs) Unit Tests
 *
 * Validates:
 * - Deep diff between two remote config snapshots
 * - Detects per-section changes: features, killswitches, sampling, etc.
 * - Collects per-field changes in the changes Map
 * - Empty diff when configs are identical
 * - Handles arrays, nested objects
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { diffConfigs } from '../../src/core/config-differ.js'
import { BAKED_IN_REMOTE_CONFIG } from '../../src/constants/defaults.js'

// Helper to make a config with overrides
function makeConfig(overrides: Record<string, unknown> = {}) {
  return { ...BAKED_IN_REMOTE_CONFIG, ...overrides } as any
}

describe('diffConfigs', () => {

  describe('Identical Configs', () => {
    it('should return no changes for identical configs', () => {
      const config = makeConfig()
      const diff = diffConfigs(config, config)

      assert.equal(diff.featuresChanged, false)
      assert.equal(diff.killswitchesChanged, false)
      assert.equal(diff.samplingChanged, false)
      assert.equal(diff.transportChanged, false)
      assert.equal(diff.securityChanged, false)
      assert.equal(diff.tracingChanged, false)
      assert.equal(diff.errorsChanged, false)
      assert.equal(diff.loggingChanged, false)
      assert.equal(diff.metricsChanged, false)
      assert.equal(diff.profilingChanged, false)
      assert.equal(diff.limitsChanged, false)
      assert.equal(diff.instrumentationChanged, false)
      assert.equal(diff.changes.size, 0)
    })
  })

  describe('Sampling Changes', () => {
    it('should detect sampling rate change', () => {
      const old = makeConfig()
      const next = makeConfig({
        sampling: { ...BAKED_IN_REMOTE_CONFIG.sampling, traces: 0.8 },
      })
      const diff = diffConfigs(old, next)
      assert.equal(diff.samplingChanged, true)
      assert.ok(diff.changes.has('sampling.traces'))
    })
  })

  describe('Killswitch Changes', () => {
    it('should detect killswitch flip', () => {
      const old = makeConfig()
      const next = makeConfig({
        killswitches: { ...BAKED_IN_REMOTE_CONFIG.killswitches, disableTracing: true },
      })
      const diff = diffConfigs(old, next)
      assert.equal(diff.killswitchesChanged, true)
      assert.ok(diff.changes.has('killswitches.disableTracing'))
    })
  })

  describe('Features Changes', () => {
    it('should detect feature toggle', () => {
      const old = makeConfig()
      const next = makeConfig({
        features: { ...BAKED_IN_REMOTE_CONFIG.features, tracing: !BAKED_IN_REMOTE_CONFIG.features.tracing },
      })
      const diff = diffConfigs(old, next)
      assert.equal(diff.featuresChanged, true)
    })
  })

  describe('Limits Changes', () => {
    it('should detect limits change', () => {
      const old = makeConfig()
      const next = makeConfig({
        limits: { ...BAKED_IN_REMOTE_CONFIG.limits, maxEventsPerSecond: 999 },
      })
      const diff = diffConfigs(old, next)
      assert.equal(diff.limitsChanged, true)
    })
  })

  describe('Multiple Sections Changed', () => {
    it('should detect changes across multiple sections simultaneously', () => {
      const old = makeConfig()
      const next = makeConfig({
        sampling: { ...BAKED_IN_REMOTE_CONFIG.sampling, traces: 0.99 },
        killswitches: { ...BAKED_IN_REMOTE_CONFIG.killswitches, disableSDK: true },
        limits: { ...BAKED_IN_REMOTE_CONFIG.limits, maxEventsPerSecond: 1 },
      })
      const diff = diffConfigs(old, next)
      assert.equal(diff.samplingChanged, true)
      assert.equal(diff.killswitchesChanged, true)
      assert.equal(diff.limitsChanged, true)
      // Unchanged sections
      assert.equal(diff.featuresChanged, false)
      assert.equal(diff.securityChanged, false)
    })
  })
})
