import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { QuotaController } from '../../src/core/quota-controller.js'
import { TenantGovernor } from '../../src/core/tenant-isolation.js'

describe('SEC-13: Rate Limiter Architecture Audit', () => {
  it('confirms QuotaController manages transport rate-limiting and Retry-After backoff', () => {
    const controller = new QuotaController({ defaultResetWindowMs: 5000 })
    assert.equal(controller.isExhausted(), false, 'Should start unexhausted')

    // Simulate HTTP 429 response with Retry-After: 3
    controller.inspectResponse(429, { 'retry-after': '3' })
    assert.equal(controller.isExhausted(), true, 'Should enter exhausted backoff on 429')

    const snapshot = controller.getSnapshot()
    assert.equal(snapshot.state, 'QUOTA_EXHAUSTED')
    assert.equal(snapshot.retryAfterMs, 3000)

    // Critical telemetry is admitted; non-critical telemetry is dropped
    assert.equal(controller.shouldAdmit('p0_critical'), true, 'Critical P0 events are admitted')
    assert.equal(controller.shouldAdmit('p2_request'), false, 'P2 events are dropped under backoff')

    controller.inspectResponse(200)
    assert.equal(controller.isExhausted(), false, '200 clears rate-limiting state')
  })

  it('confirms TenantGovernor enforces tenant-level throughput governance', () => {
    const governor = new TenantGovernor({
      enabled: true,
      maxTenantsTracked: 100,
      quotaPerWindow: 2,
      windowDurationMs: 60000,
      criticalReserve: 1,
    })

    assert.equal(governor.admit('tenant-x', false), true, 'First event admitted')
    assert.equal(governor.admit('tenant-x', false), true, 'Second event admitted (at quota)')
    assert.equal(governor.admit('tenant-x', false), false, 'Third event rejected over quota')
    assert.equal(governor.admit('tenant-x', true), true, 'Critical event admitted via reserve')
  })
})
