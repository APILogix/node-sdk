import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { QuotaController } from '../../src/core/quota-controller.js'

describe('QuotaController & Automatic Recovery', () => {
  let controller: QuotaController

  beforeEach(() => {
    controller = new QuotaController({ defaultResetWindowMs: 200 })
  })

  it('starts in QUOTA_OK state and admits all telemetry', () => {
    assert.equal(controller.getState(), 'QUOTA_OK')
    assert.equal(controller.isExhausted(), false)
    assert.equal(controller.shouldAdmit('p0_critical'), true)
    assert.equal(controller.shouldAdmit('p1_error'), true)
    assert.equal(controller.shouldAdmit('p2_request'), true)
    assert.equal(controller.shouldAdmit('p3_low'), true)
  })

  it('transitions to QUOTA_EXHAUSTED on HTTP 429 and preserves P0 while dropping P2/P3', () => {
    controller.inspectResponse(429, { 'retry-after': '60' })

    assert.equal(controller.getState(), 'QUOTA_EXHAUSTED')
    assert.equal(controller.isExhausted(), true)

    // P0 fatal/crash is NEVER dropped
    assert.equal(controller.shouldAdmit('p0_critical'), true)

    // P2 and P3 are suppressed
    assert.equal(controller.shouldAdmit('p2_request'), false)
    assert.equal(controller.shouldAdmit('p3_low'), false)

    const snapshot = controller.getSnapshot()
    assert.equal(snapshot.droppedEventsCount, 2)
  })

  it('recovers automatically when a successful 200 OK response arrives', () => {
    controller.setQuotaExhausted()
    assert.equal(controller.isExhausted(), true)

    controller.inspectResponse(200)
    assert.equal(controller.getState(), 'QUOTA_OK')
    assert.equal(controller.isExhausted(), false)
    assert.equal(controller.shouldAdmit('p2_request'), true)
  })

  it('recovers automatically when reset timestamp elapses without restart', async () => {
    const shortResetController = new QuotaController({ defaultResetWindowMs: 50 })
    shortResetController.setQuotaExhausted()
    assert.equal(shortResetController.isExhausted(), true)

    await new Promise(r => setTimeout(r, 80))

    assert.equal(shortResetController.getState(), 'QUOTA_OK')
    assert.equal(shortResetController.isExhausted(), false)
    shortResetController.destroy()
  })

  it('parses X-Pulse-Quota headers accurately', () => {
    controller.inspectResponse(200, {
      'x-pulse-quota-limit': '10000',
      'x-pulse-quota-remaining': '250',
      'x-pulse-quota-status': 'near_limit',
    })

    const snapshot = controller.getSnapshot()
    assert.equal(snapshot.state, 'QUOTA_NEAR_LIMIT')
    assert.equal(snapshot.quotaLimit, 10000)
    assert.equal(snapshot.quotaRemaining, 250)
    assert.equal(snapshot.quotaUsed, 9750)
  })
})
