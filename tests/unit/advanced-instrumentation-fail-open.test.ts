import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  registerBootstrapAutoInstrumentations,
  registerAutoInstrumentations,
  resetAutoInstrumentations,
} from '../../src/instrumentation/auto-instrument.js'
import { validateRemoteConfig } from '../../src/core/config-validator.js'
import { DEFAULT_REMOTE_CONFIG } from '../../src/constants/defaults.js'
import { applyIdempotentPatch } from '../../src/instrumentation/safe-wrapper.js'

import { ConfigManager } from '../../src/core/config-manager.js'

describe('Advanced Instrumentation: Fail-Open & Reliability Invariants', () => {
  it('applies idempotent patches at most once per process symbol', () => {
    const testSymbol = Symbol('pulse-sdk.test-guard')
    let patchCount = 0

    const res1 = applyIdempotentPatch(testSymbol, () => {
      patchCount++
      return () => {
        patchCount--
      }
    })
    const res2 = applyIdempotentPatch(testSymbol, () => {
      patchCount++
    })

    assert.equal(res1, true)
    assert.equal(res2, false)
    assert.equal(patchCount, 1)
  })

  it('validates DEFAULT_REMOTE_CONFIG containing all new instrumentation defaults with 0 errors', () => {
    const res = validateRemoteConfig(DEFAULT_REMOTE_CONFIG)
    assert.equal(res.valid, true, `Validation errors: ${res.errors.join('; ')}`)
    assert.equal(res.errors.length, 0)
  })

  it('validates custom remote configs enabling new instrumentations', () => {
    const candidate = JSON.parse(JSON.stringify(DEFAULT_REMOTE_CONFIG))
    candidate.instrumentation.dynamodb = { enabled: true, captureQueries: true, captureParams: true }
    candidate.instrumentation.cassandra = { enabled: true, captureQueries: true, captureParams: false }
    candidate.instrumentation.elasticsearch = { enabled: true, captureQueries: true }
    candidate.instrumentation.typeorm = { enabled: true, captureQueries: true }
    candidate.instrumentation.drizzle = { enabled: true, captureQueries: true }
    candidate.instrumentation.kafkajs = { enabled: true, emitConsumerBatchSpans: true, captureMessageKey: true }
    candidate.instrumentation.amqplib = { enabled: true, captureMessageData: true }
    candidate.instrumentation.dns = { enabled: true }

    const res = validateRemoteConfig(candidate)
    assert.equal(res.valid, true, `Validation errors: ${res.errors.join('; ')}`)
  })

  it('rejects invalid non-boolean values in sub-config options', () => {
    const candidate = JSON.parse(JSON.stringify(DEFAULT_REMOTE_CONFIG))
    candidate.instrumentation.dynamodb = { enabled: 'invalid-string' }

    const res = validateRemoteConfig(candidate)
    assert.equal(res.valid, false)
    assert.match(res.errors.join('; '), /instrumentation\.dynamodb\.enabled/)
  })

  it('survives multiple registerAutoInstrumentations and resetAutoInstrumentations cycles without leaks', () => {
    ConfigManager.getInstance().initialize({} as any, DEFAULT_REMOTE_CONFIG as any)
    assert.doesNotThrow(() => {
      registerAutoInstrumentations()
      resetAutoInstrumentations()
      registerAutoInstrumentations()
      resetAutoInstrumentations()
    })
  })

  it('survives registerBootstrapAutoInstrumentations cleanly before remote config arrives', () => {
    assert.doesNotThrow(() => {
      registerBootstrapAutoInstrumentations()
      resetAutoInstrumentations()
    })
  })
})
