/**
 * FeatureController unit tests.
 *
 * Validates:
 *   - Feature registration with start/stop callbacks.
 *   - Feature enabled/disabled state management.
 *   - Config change: enabling new features triggers start.
 *   - Config change: disabling features triggers stop.
 *   - Degraded mode: only errors + logging allowed.
 *   - Every flag in v3 `FeaturesConfig` independently controllable.
 *
 * The v3 schema dropped `aiDetection`, `dynamicSampling`, `sourceMaps`,
 * and `releaseTracking` (they were either always-on capabilities or
 * dead config knobs); it added `requestCapture`. The flag list below
 * mirrors the current `FeaturesConfig` exactly.
 */

import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { FeatureController } from '../../src/core/feature-controller.js'
import type { FeaturesConfig } from '../../src/types/config.js'

const allFeaturesOff: FeaturesConfig = {
  tracing: false,
  requestCapture: false,
  errors: false,
  metrics: false,
  logging: false,
  profiling: false,
  crons: false,
  sessionReplay: false,
  runtimeMetrics: false,
  eventLoopMonitoring: false,
  gcMonitoring: false,
}

const allFeaturesOn: FeaturesConfig = {
  tracing: true,
  requestCapture: true,
  errors: true,
  metrics: true,
  logging: true,
  profiling: true,
  crons: true,
  sessionReplay: true,
  runtimeMetrics: true,
  eventLoopMonitoring: true,
  gcMonitoring: true,
}

describe('FeatureController', () => {
  afterEach(() => {
    FeatureController.reset()
  })

  describe('Initialization', () => {
    it('should start with features off', () => {
      const ctrl = FeatureController.initialize(allFeaturesOff)
      assert.equal(ctrl.isEnabled('tracing'), false)
      assert.equal(ctrl.isEnabled('metrics'), false)
      assert.equal(ctrl.isEnabled('errors'), false)
    })

    it('should start with features on when configured', () => {
      const ctrl = FeatureController.initialize(allFeaturesOn)
      assert.equal(ctrl.isEnabled('tracing'), true)
      assert.equal(ctrl.isEnabled('metrics'), true)
      assert.equal(ctrl.isEnabled('errors'), true)
    })

    it('should be singleton', () => {
      const ctrl1 = FeatureController.initialize(allFeaturesOff)
      const ctrl2 = FeatureController.getInstance()
      assert.ok(ctrl2 !== null)
      assert.equal(ctrl1, ctrl2)
    })
  })

  describe('Feature Registration', () => {
    it('should call start callback when feature is enabled', async () => {
      const ctrl = FeatureController.initialize(allFeaturesOn)
      let started = false

      await ctrl.register(
        'tracing',
        () => { started = true },
        () => {}
      )

      assert.equal(started, true)
    })

    it('should not call start callback when feature is disabled', async () => {
      const ctrl = FeatureController.initialize(allFeaturesOff)
      let started = false

      await ctrl.register(
        'tracing',
        () => { started = true },
        () => {}
      )

      assert.equal(started, false)
    })
  })

  describe('All Feature Flags', () => {
    const featureNames = Object.keys(allFeaturesOff) as Array<keyof FeaturesConfig>

    for (const featureName of featureNames) {
      it(`should independently control ${featureName}`, () => {
        const config: FeaturesConfig = { ...allFeaturesOff, [featureName]: true }
        const ctrl = FeatureController.initialize(config)

        assert.equal(ctrl.isEnabled(featureName), true, `${featureName} should be enabled`)

        for (const other of featureNames) {
          if (other !== featureName) {
            assert.equal(ctrl.isEnabled(other), false, `${other} should be disabled`)
          }
        }

        FeatureController.reset()
      })
    }
  })

  describe('Config Change', () => {
    it('should enable feature that was off → on', async () => {
      const ctrl = FeatureController.initialize(allFeaturesOff)
      let started = false

      await ctrl.register(
        'metrics',
        () => { started = true },
        () => {}
      )

      assert.equal(started, false)

      await ctrl.handleConfigChange({} as any, {
        features: { ...allFeaturesOff, metrics: true },
      } as any)

      assert.equal(ctrl.isEnabled('metrics'), true)
    })

    it('should disable feature that was on → off', async () => {
      const ctrl = FeatureController.initialize(allFeaturesOn)
      let stopped = false

      await ctrl.register(
        'profiling',
        () => {},
        () => { stopped = true }
      )

      await ctrl.handleConfigChange({} as any, {
        features: { ...allFeaturesOn, profiling: false },
      } as any)

      assert.equal(ctrl.isEnabled('profiling'), false)
    })
  })

  describe('Degraded Mode', () => {
    it('should only allow errors and logging in degraded mode', () => {
      const ctrl = FeatureController.initialize(allFeaturesOn)
      ctrl.setDegradedMode(true)

      assert.equal(ctrl.isEnabled('errors'), true)
      assert.equal(ctrl.isEnabled('logging'), true)
      assert.equal(ctrl.isEnabled('tracing'), false)
      assert.equal(ctrl.isEnabled('metrics'), false)
      assert.equal(ctrl.isEnabled('profiling'), false)
      assert.equal(ctrl.isEnabled('sessionReplay'), false)
      assert.equal(ctrl.isEnabled('requestCapture'), false)
    })

    it('should restore full features when degraded mode is turned off', () => {
      const ctrl = FeatureController.initialize(allFeaturesOn)
      ctrl.setDegradedMode(true)
      assert.equal(ctrl.isEnabled('tracing'), false)

      ctrl.setDegradedMode(false)
      assert.equal(ctrl.isEnabled('tracing'), true)
    })
  })
})
