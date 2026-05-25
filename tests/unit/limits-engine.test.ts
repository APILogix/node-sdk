/**
 * LimitsEngine unit tests.
 *
 * Validates:
 *   - Attribute count enforcement (`maxSpanAttributes`).
 *   - Attribute length truncation (`maxAttributeLength`).
 *   - Payload size checking (`maxPayloadSize`).
 *   - Config hot-swap.
 *
 * v3 simplified `LimitsConfig` substantially — `maxEventsPerSecond`,
 * `maxBreadcrumbs`, and `maxAttributesPerEvent` are gone (rate limiting
 * moved to `loadShedder`/`tenantGovernor`; breadcrumbs is an init option;
 * attribute count was renamed to `maxSpanAttributes`). `admitEvent()` is
 * now a no-op shim retained only so the event pipeline doesn't have to
 * fork by SDK version.
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { LimitsEngine } from '../../src/core/limits-engine.js'
import type { LimitsConfig } from '../../src/types/config.js'

const baseLimitsConfig: LimitsConfig = {
  maxSpansPerTrace: 500,
  maxSpanAttributes: 10,
  maxAttributeLength: 100,
  maxPayloadSize: 262144,
  maxQueueSize: 10000,
  maxMemoryMb: 256,
  maxCpuOverheadPercent: 5,
}

describe('LimitsEngine', () => {
  let engine: LimitsEngine

  beforeEach(() => {
    engine = LimitsEngine.initialize(baseLimitsConfig)
  })

  afterEach(() => {
    LimitsEngine.reset()
  })

  describe('Admission (legacy shim)', () => {
    it('admitEvent() always returns true post-v3', () => {
      // Rate limiting moved out of LimitsEngine; the method is retained as
      // a no-op so the pipeline doesn't need a version check.
      for (let i = 0; i < 1_000; i++) {
        assert.equal(engine.admitEvent(), true)
      }
    })
  })

  describe('Attribute Limits', () => {
    it('should truncate excess attributes', () => {
      const event: any = { type: 'span', attributes: {} }
      for (let i = 0; i < 20; i++) {
        event.attributes[`key_${i}`] = `value_${i}`
      }
      const enforced = engine.enforceAttributeLimits(event)
      const attrCount = Object.keys((enforced as any).attributes || {}).length
      assert.ok(attrCount <= 10, `expected ≤10 attributes, got ${attrCount}`)
    })

    it('should truncate long attribute values with ellipsis', () => {
      const longValue = 'x'.repeat(200)
      const event: any = { type: 'span', attributes: { key1: longValue } }
      const enforced = engine.enforceAttributeLimits(event)
      const value = (enforced as any).attributes?.['key1']
      assert.equal(typeof value, 'string')
      assert.ok(value.length <= 101, `expected ≤101 chars, got ${value.length}`)
      assert.ok(value.endsWith('…'), 'truncated value should end with ellipsis')
    })

    it('should pass through events within limits', () => {
      const event: any = {
        type: 'span',
        attributes: { key1: 'short', key2: 'also short' },
      }
      const enforced = engine.enforceAttributeLimits(event)
      assert.equal((enforced as any).attributes?.['key1'], 'short')
      assert.equal((enforced as any).attributes?.['key2'], 'also short')
    })

    it('should also enforce on context and tags fields', () => {
      const errorEvent: any = { type: 'error', context: {} }
      const metricEvent: any = { type: 'metric', tags: {} }
      for (let i = 0; i < 20; i++) {
        errorEvent.context[`k_${i}`] = `v_${i}`
        metricEvent.tags[`k_${i}`] = `v_${i}`
      }
      assert.ok(Object.keys(engine.enforceAttributeLimits(errorEvent).context).length <= 10)
      assert.ok(Object.keys(engine.enforceAttributeLimits(metricEvent).tags).length <= 10)
    })
  })

  describe('Payload Size', () => {
    it('accepts payloads within limit', () => {
      assert.equal(engine.checkPayloadSize(1024), true)
      assert.equal(engine.checkPayloadSize(baseLimitsConfig.maxPayloadSize), true)
    })

    it('rejects payloads above limit', () => {
      assert.equal(engine.checkPayloadSize(baseLimitsConfig.maxPayloadSize + 1), false)
    })
  })

  describe('Config Change', () => {
    it('should update limits on config change', () => {
      engine.handleConfigChange({} as any, {
        limits: { ...baseLimitsConfig, maxSpanAttributes: 5 },
      } as any)

      const event: any = { type: 'span', attributes: {} }
      for (let i = 0; i < 10; i++) event.attributes[`k_${i}`] = `v_${i}`

      const enforced = engine.enforceAttributeLimits(event)
      const count = Object.keys((enforced as any).attributes || {}).length
      assert.ok(count <= 5, `expected ≤5 after config change, got ${count}`)
    })

    it('exposes maxSpansPerTrace via getter', () => {
      assert.equal(engine.getMaxSpansPerTrace(), 500)
    })
  })
})
