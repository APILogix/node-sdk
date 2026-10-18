import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { SamplingEngine } from '../../src/core/sampling-engine.js'
import { adaptivePressure } from '../../src/utils/adaptive-pressure.js'
import type { SamplingConfig } from '../../src/types/config.js'

const testSamplingConfig: SamplingConfig = {
  traces: 1.0,
  requests: 1.0,
  spans: 1.0,
  errors: 1.0,
  messages: 1.0,
  profiles: 1.0,
  metrics: 1.0,
  logs: 1.0,
  events: 1.0,
  crons: 1.0,
  routes: {},
}

describe('Dynamic Adaptive Sampling Under System Pressure', () => {
  beforeEach(() => {
    SamplingEngine.reset()
  })

  afterEach(() => {
    SamplingEngine.reset()
  })

  it('1. Baseline sampling preserves full rates when adaptive is false or state is HEALTHY', () => {
    const engine = SamplingEngine.initialize(testSamplingConfig, { adaptive: false })
    const traceDecision = engine.shouldSampleTrace('test-trace-1')
    assert.equal(traceDecision.sampled, true)
    assert.equal(traceDecision.rate, 1.0)
    assert.equal(traceDecision.reason, 'always_sample')

    const errorDecision = engine.shouldSampleError('test-error-1')
    assert.equal(errorDecision.sampled, true)
    assert.equal(errorDecision.rate, 1.0)
  })

  it('2. Adaptive sampling dynamically throttles non-error telemetry when state is CRITICAL', () => {
    const engine = SamplingEngine.initialize(testSamplingConfig, { adaptive: true })

    // Simulate CRITICAL state on adaptivePressure
    const origGetState = adaptivePressure.getState
    adaptivePressure.getState = () => 'CRITICAL' as any

    try {
      const traceDecision = engine.shouldSampleTrace('test-trace-1')
      assert.equal(traceDecision.rate, 0.10, 'Trace sampling rate should adaptively scale down to 10% under CRITICAL pressure')
      assert.equal(traceDecision.reason, 'adaptive_pressure')

      // Errors must NEVER be scaled down by adaptive pressure
      const errorDecision = engine.shouldSampleError('test-error-1')
      assert.equal(errorDecision.rate, 1.0, 'Error sampling rate must remain 100% even under CRITICAL pressure')
      assert.equal(errorDecision.sampled, true)
    } finally {
      adaptivePressure.getState = origGetState
    }
  })

  it('3. Adaptive sampling scales down by 50% in PRESSURED state', () => {
    const engine = SamplingEngine.initialize({ ...testSamplingConfig, traces: 0.8 }, { adaptive: true })

    const origGetState = adaptivePressure.getState
    adaptivePressure.getState = () => 'PRESSURED' as any

    try {
      const traceDecision = engine.shouldSampleTrace('test-trace-pressured')
      assert.equal(traceDecision.rate, 0.40, '0.8 rate should scale to 0.40 under PRESSURED state (50%)')
      assert.equal(traceDecision.reason, 'adaptive_pressure')
    } finally {
      adaptivePressure.getState = origGetState
    }
  })

  it('4. Toggling setAdaptive dynamically switches adaptive mode', () => {
    const engine = SamplingEngine.initialize(testSamplingConfig, { adaptive: false })
    assert.equal(engine.isAdaptive(), false)

    engine.setAdaptive(true)
    assert.equal(engine.isAdaptive(), true)

    engine.setAdaptive(false)
    assert.equal(engine.isAdaptive(), false)
  })
})
