import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { diffConfigs, deepEqual } from '../../src/core/config-differ.js'
import { TEST_REMOTE_CONFIG } from '../fixtures/remote-config.js'

function cloneConfig(overrides: Record<string, unknown> = {}) {
  return JSON.parse(JSON.stringify({ ...TEST_REMOTE_CONFIG, ...overrides }))
}

describe('ConfigDiffer Unit Test Suite', () => {
  describe('1. Identical Configs & Zero-Diff Guarantees', () => {
    it('returns hasChanges === false for identical reference', () => {
      const diff = diffConfigs(TEST_REMOTE_CONFIG, TEST_REMOTE_CONFIG)
      assert.equal(diff.hasChanges, false)
      assert.equal(diff.sdkChanged, false)
      assert.equal(diff.featuresChanged, false)
      assert.equal(diff.killswitchesChanged, false)
      assert.equal(diff.samplingChanged, false)
      assert.equal(diff.transportChanged, false)
      assert.equal(diff.privacyChanged, false)
      assert.equal(diff.limitsChanged, false)
      assert.equal(diff.instrumentationChanged, false)
      assert.equal(diff.entitlementsChanged, false)
      assert.equal(diff.profilingChanged, false)
      assert.equal(diff.replayChanged, false)
      assert.equal(diff.tracingChanged, false)
      assert.equal(diff.metricsChanged, false)
      assert.equal(diff.loggingChanged, false)
      assert.equal(diff.errorsChanged, false)
      assert.equal(diff.changes.size, 0)
      assert.equal(diff.fieldChanges.length, 0)
      assert.equal(diff.addedKeys.length, 0)
      assert.equal(diff.removedKeys.length, 0)
      assert.equal(diff.modifiedKeys.length, 0)
    })

    it('returns hasChanges === false for separate deep-cloned identical objects', () => {
      const configA = cloneConfig()
      const configB = cloneConfig()
      const diff = diffConfigs(configA, configB)
      assert.equal(diff.hasChanges, false)
      assert.equal(diff.changes.size, 0)
    })
  })

  describe('2. Feature Toggles & Subsystem Fast Flags', () => {
    it('detects profiling toggle and activates profilingChanged flag', () => {
      const oldCfg = cloneConfig()
      const newCfg = cloneConfig()
      newCfg.features.profiling = true

      const diff = diffConfigs(oldCfg, newCfg)
      assert.equal(diff.hasChanges, true)
      assert.equal(diff.featuresChanged, true)
      assert.equal(diff.profilingChanged, true)
      assert.equal(diff.replayChanged, false)
      assert.equal(diff.changes.has('features.profiling'), true)

      const change = diff.changes.get('features.profiling')
      assert.deepEqual(change, { old: false, new: true, changeType: 'modified' })
    })

    it('detects sessionReplay toggle and activates replayChanged flag', () => {
      const oldCfg = cloneConfig()
      const newCfg = cloneConfig()
      newCfg.features.sessionReplay = true

      const diff = diffConfigs(oldCfg, newCfg)
      assert.equal(diff.hasChanges, true)
      assert.equal(diff.featuresChanged, true)
      assert.equal(diff.replayChanged, true)
      assert.equal(diff.profilingChanged, false)
      assert.equal(diff.changes.has('features.sessionReplay'), true)
    })

    it('detects tracing toggle and activates tracingChanged flag', () => {
      const oldCfg = cloneConfig()
      const newCfg = cloneConfig()
      newCfg.features.tracing = true

      const diff = diffConfigs(oldCfg, newCfg)
      assert.equal(diff.hasChanges, true)
      assert.equal(diff.featuresChanged, true)
      assert.equal(diff.tracingChanged, true)
    })

    it('detects requestCapture toggle independently of tracing', () => {
      const oldCfg = cloneConfig()
      const newCfg = cloneConfig()
      newCfg.features.requestCapture = true

      const diff = diffConfigs(oldCfg, newCfg)
      assert.equal(diff.hasChanges, true)
      assert.equal(diff.featuresChanged, true)
      assert.equal(diff.changes.has('features.requestCapture'), true)
    })

    it('detects metrics & runtimeMetrics toggles and activates metricsChanged flag', () => {
      const oldCfg = cloneConfig()
      const newCfg = cloneConfig()
      newCfg.features.metrics = true
      newCfg.features.runtimeMetrics = true

      const diff = diffConfigs(oldCfg, newCfg)
      assert.equal(diff.hasChanges, true)
      assert.equal(diff.featuresChanged, true)
      assert.equal(diff.metricsChanged, true)
    })

    it('detects logging toggle and activates loggingChanged flag', () => {
      const oldCfg = cloneConfig()
      const newCfg = cloneConfig()
      newCfg.features.logging = true

      const diff = diffConfigs(oldCfg, newCfg)
      assert.equal(diff.hasChanges, true)
      assert.equal(diff.featuresChanged, true)
      assert.equal(diff.loggingChanged, true)
    })

    it('detects errors toggle and activates errorsChanged flag', () => {
      const oldCfg = cloneConfig()
      const newCfg = cloneConfig()
      newCfg.features.errors = true

      const diff = diffConfigs(oldCfg, newCfg)
      assert.equal(diff.hasChanges, true)
      assert.equal(diff.featuresChanged, true)
      assert.equal(diff.errorsChanged, true)
    })
  })

  describe('3. Killswitches & Entitlements Fast-Flag Interactions', () => {
    it('killswitches.disableProfiling activates profilingChanged', () => {
      const oldCfg = cloneConfig()
      const newCfg = cloneConfig()
      newCfg.killswitches.disableProfiling = true

      const diff = diffConfigs(oldCfg, newCfg)
      assert.equal(diff.killswitchesChanged, true)
      assert.equal(diff.profilingChanged, true)
      assert.equal(diff.changes.has('killswitches.disableProfiling'), true)
    })

    it('killswitches.disableTracing activates tracingChanged', () => {
      const oldCfg = cloneConfig()
      const newCfg = cloneConfig()
      newCfg.killswitches.disableTracing = true

      const diff = diffConfigs(oldCfg, newCfg)
      assert.equal(diff.killswitchesChanged, true)
      assert.equal(diff.tracingChanged, true)
    })

    it('entitlements.sessionReplay toggle activates replayChanged', () => {
      const oldCfg = cloneConfig()
      const newCfg = cloneConfig()
      newCfg.entitlements.sessionReplay = false

      const diff = diffConfigs(oldCfg, newCfg)
      assert.equal(diff.entitlementsChanged, true)
      assert.equal(diff.replayChanged, true)
    })

    it('entitlements.customSpans toggle activates tracingChanged', () => {
      const oldCfg = cloneConfig()
      const newCfg = cloneConfig()
      newCfg.entitlements.customSpans = false

      const diff = diffConfigs(oldCfg, newCfg)
      assert.equal(diff.entitlementsChanged, true)
      assert.equal(diff.tracingChanged, true)
    })
  })

  describe('4. Transport Route & Connection Changes', () => {
    it('detects route batchSize modification with precise field change', () => {
      const oldCfg = cloneConfig()
      const newCfg = cloneConfig()
      newCfg.transport.routes.errors.batchSize = 25

      const diff = diffConfigs(oldCfg, newCfg)
      assert.equal(diff.hasChanges, true)
      assert.equal(diff.transportChanged, true)
      assert.equal(diff.changes.has('transport.routes.errors.batchSize'), true)

      const change = diff.changes.get('transport.routes.errors.batchSize')
      assert.deepEqual(change, { old: 100, new: 25, changeType: 'modified' })
    })

    it('detects compression algorithm switch from gzip to none', () => {
      const oldCfg = cloneConfig()
      const newCfg = cloneConfig()
      newCfg.transport.routes.traces.compression = 'none'

      const diff = diffConfigs(oldCfg, newCfg)
      assert.equal(diff.transportChanged, true)
      assert.equal(diff.changes.has('transport.routes.traces.compression'), true)
    })

    it('detects transport connection pool total cap changes', () => {
      const oldCfg = cloneConfig()
      const newCfg = cloneConfig()
      newCfg.transport.connections.maxTotalConnections = 50

      const diff = diffConfigs(oldCfg, newCfg)
      assert.equal(diff.transportChanged, true)
      assert.equal(diff.changes.has('transport.connections.maxTotalConnections'), true)
    })

    it('detects transport retry parameter mutations', () => {
      const oldCfg = cloneConfig()
      const newCfg = cloneConfig()
      newCfg.transport.retry.maxRetries = 5
      newCfg.transport.retry.backoff = 'linear'

      const diff = diffConfigs(oldCfg, newCfg)
      assert.equal(diff.transportChanged, true)
      assert.equal(diff.changes.has('transport.retry.maxRetries'), true)
      assert.equal(diff.changes.has('transport.retry.backoff'), true)
    })
  })

  describe('5. Sampling Configuration Mutations', () => {
    it('detects global traces sampling rate update and triggers tracingChanged', () => {
      const oldCfg = cloneConfig()
      const newCfg = cloneConfig()
      newCfg.sampling.traces = 0.75

      const diff = diffConfigs(oldCfg, newCfg)
      assert.equal(diff.samplingChanged, true)
      assert.equal(diff.tracingChanged, true)
      assert.equal(diff.changes.has('sampling.traces'), true)
    })

    it('detects added route-specific sampling override', () => {
      const oldCfg = cloneConfig()
      const newCfg = cloneConfig()
      newCfg.sampling.routes['/api/v2/checkout'] = { traces: 1.0, requests: 1.0 }

      const diff = diffConfigs(oldCfg, newCfg)
      assert.equal(diff.samplingChanged, true)
      assert.equal(diff.tracingChanged, true)
      assert.ok(
        diff.addedKeys.includes('sampling.routes./api/v2/checkout') ||
        diff.changes.has('sampling.routes./api/v2/checkout.traces') ||
        diff.addedKeys.includes('sampling.routes./api/v2/checkout.traces'),
      )
    })

    it('detects removed route-specific sampling override', () => {
      const oldCfg = cloneConfig()
      oldCfg.sampling.routes['/health'] = { traces: 0, requests: 0 }
      const newCfg = cloneConfig()

      const diff = diffConfigs(oldCfg, newCfg)
      assert.equal(diff.samplingChanged, true)
      assert.ok(
        diff.removedKeys.some(k => k.startsWith('sampling.routes./health')) ||
        diff.changes.has('sampling.routes./health'),
      )
    })

    it('detects route-specific profile sampling override and triggers profilingChanged', () => {
      const oldCfg = cloneConfig()
      const newCfg = cloneConfig()
      newCfg.sampling.routes['/compute'] = { profiles: 0.5 }

      const diff = diffConfigs(oldCfg, newCfg)
      assert.equal(diff.samplingChanged, true)
      assert.equal(diff.profilingChanged, true)
    })
  })

  describe('6. Limits, Privacy & Array Mutations', () => {
    it('detects maxQueueSize limit mutation', () => {
      const oldCfg = cloneConfig()
      const newCfg = cloneConfig()
      newCfg.limits.maxQueueSize = 50000

      const diff = diffConfigs(oldCfg, newCfg)
      assert.equal(diff.limitsChanged, true)
      assert.equal(diff.changes.has('limits.maxQueueSize'), true)
    })

    it('detects scrubbing field additions in privacy configuration', () => {
      const oldCfg = cloneConfig()
      const newCfg = cloneConfig()
      newCfg.privacy.scrubbing.fields = ['password', 'token', 'newCustomSecret']

      const diff = diffConfigs(oldCfg, newCfg)
      assert.equal(diff.privacyChanged, true)
      assert.equal(diff.changes.has('privacy.scrubbing.fields'), true)
      assert.equal(diff.modifiedKeys.includes('privacy.scrubbing.fields'), true)
    })

    it('detects piiDetection boolean flips', () => {
      const oldCfg = cloneConfig()
      const newCfg = cloneConfig()
      newCfg.privacy.piiDetection.maskIPs = false

      const diff = diffConfigs(oldCfg, newCfg)
      assert.equal(diff.privacyChanged, true)
      assert.equal(diff.changes.has('privacy.piiDetection.maskIPs'), true)
    })
  })

  describe('7. Crash-Proof Null & Undefined Safety', () => {
    it('safely handles null oldConfig without throwing', () => {
      const newCfg = cloneConfig()
      let diff: any
      assert.doesNotThrow(() => {
        diff = diffConfigs(null, newCfg)
      })
      assert.equal(diff.hasChanges, true)
      assert.ok(diff.fieldChanges.length > 0)
    })

    it('safely handles null newConfig without throwing', () => {
      const oldCfg = cloneConfig()
      let diff: any
      assert.doesNotThrow(() => {
        diff = diffConfigs(oldCfg, null)
      })
      assert.equal(diff.hasChanges, true)
      assert.ok(diff.removedKeys.length > 0)
    })

    it('safely handles both arguments being null or undefined', () => {
      const diff1 = diffConfigs(null, null)
      assert.equal(diff1.hasChanges, false)
      assert.equal(diff1.changes.size, 0)

      const diff2 = diffConfigs(undefined, undefined)
      assert.equal(diff2.hasChanges, false)
      assert.equal(diff2.changes.size, 0)
    })
  })

  describe('8. Simultaneous Multi-Section Mutations', () => {
    it('detects mutations across 4 distinct sections simultaneously while keeping unaffected false', () => {
      const oldCfg = cloneConfig()
      const newCfg = cloneConfig()

      // Section 1: sdk
      newCfg.sdk.release = '2.0.0-rc.1'
      // Section 2: features
      newCfg.features.crons = true
      // Section 3: limits
      newCfg.limits.maxMemoryMb = 'auto'
      // Section 4: transport
      newCfg.transport.routes.crons.compression = 'gzip'

      const diff = diffConfigs(oldCfg, newCfg)
      assert.equal(diff.hasChanges, true)
      assert.equal(diff.sdkChanged, true)
      assert.equal(diff.featuresChanged, true)
      assert.equal(diff.limitsChanged, true)
      assert.equal(diff.transportChanged, true)

      // Unchanged sections remain strictly false
      assert.equal(diff.killswitchesChanged, false)
      assert.equal(diff.samplingChanged, false)
      assert.equal(diff.privacyChanged, false)
      assert.equal(diff.instrumentationChanged, false)
      assert.equal(diff.entitlementsChanged, false)

      assert.equal(diff.changes.has('sdk.release'), true)
      assert.equal(diff.changes.has('features.crons'), true)
      assert.equal(diff.changes.has('limits.maxMemoryMb'), true)
      assert.equal(diff.changes.has('transport.routes.crons.compression'), true)
    })
  })

  describe('9. deepEqual Utility Edge Cases', () => {
    it('compares NaN equality correctly', () => {
      assert.equal(deepEqual(NaN, NaN), true)
      assert.equal(deepEqual(NaN, 0), false)
    })

    it('compares null vs undefined vs objects', () => {
      assert.equal(deepEqual(null, undefined), false)
      assert.equal(deepEqual({}, null), false)
      assert.equal(deepEqual([], {}), false)
    })

    it('compares nested arrays with different orders as unequal', () => {
      assert.equal(deepEqual([1, 2, 3], [1, 2, 3]), true)
      assert.equal(deepEqual([1, 2, 3], [3, 2, 1]), false)
      assert.equal(deepEqual([1, 2], [1, 2, 3]), false)
    })
  })
})
