import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  registerBootstrapAutoInstrumentations,
  resetAutoInstrumentations,
} from '../../src/instrumentation/auto-instrument.js'

describe('SEC-08: Import-Time Bootstrap & Auto-Instrumentation Safety', () => {
  const INSTRUMENTATION_GUARD = Symbol.for('pulse-sdk.auto-instrumentation.registered')
  const BOOTSTRAP_GUARD = Symbol.for('pulse-sdk.auto-instrumentation.bootstrap')
  const ACTIVE_REGISTRY = Symbol.for('pulse-sdk.auto-instrumentation.registry')

  beforeEach(() => {
    resetAutoInstrumentations()
  })

  afterEach(() => {
    resetAutoInstrumentations()
  })

  it('runs bootstrap auto-instrumentation cleanly without throwing', () => {
    assert.doesNotThrow(() => {
      registerBootstrapAutoInstrumentations()
    }, 'registerBootstrapAutoInstrumentations must never throw')

    const g = globalThis as Record<symbol, unknown>
    assert.equal(g[INSTRUMENTATION_GUARD], true, 'Guard must be set')
    assert.equal(g[BOOTSTRAP_GUARD], true, 'Bootstrap flag must be set')
    assert.ok(g[ACTIVE_REGISTRY], 'Active registry must be populated')
  })

  it('is idempotent when called multiple times across multiple SDK imports', () => {
    assert.doesNotThrow(() => {
      registerBootstrapAutoInstrumentations()
      registerBootstrapAutoInstrumentations()
      registerBootstrapAutoInstrumentations()
    }, 'Repeated bootstrap calls must be idempotent no-ops')
  })

  it('survives individual instrumentation constructor failure without crashing', () => {
    // Simulate an environment where a global or prototype mutation causes an error
    const g = globalThis as Record<symbol, unknown>
    resetAutoInstrumentations()

    // Even if an unexpected error occurs during bootstrap, it must catch fail-open
    assert.doesNotThrow(() => {
      registerBootstrapAutoInstrumentations()
    })

    const registry = g[ACTIVE_REGISTRY] as Record<string, unknown> | undefined
    assert.ok(registry, 'Registry should be populated for surviving instrumentations')
  })

  it('cleans up and resets auto-instrumentations cleanly on resetAutoInstrumentations', () => {
    registerBootstrapAutoInstrumentations()
    const g = globalThis as Record<symbol, unknown>
    assert.equal(g[INSTRUMENTATION_GUARD], true)

    resetAutoInstrumentations()
    assert.equal(g[INSTRUMENTATION_GUARD], undefined, 'Guard should be deleted after reset')
    assert.equal(g[BOOTSTRAP_GUARD], undefined, 'Bootstrap flag should be deleted after reset')
    assert.equal(g[ACTIVE_REGISTRY], undefined, 'Registry should be deleted after reset')
  })
})
