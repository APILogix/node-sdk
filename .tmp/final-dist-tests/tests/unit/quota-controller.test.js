import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { QuotaController } from '../../src/core/quota-controller.js';
describe('QuotaController — Transport Rate-Limit & Backpressure Protection', () => {
    let controller;
    beforeEach(() => {
        controller = new QuotaController({ defaultResetWindowMs: 200 });
    });
    it('starts in QUOTA_OK state and admits all telemetry', () => {
        assert.equal(controller.getState(), 'QUOTA_OK');
        assert.equal(controller.isExhausted(), false);
        assert.equal(controller.shouldAdmit('p0_critical'), true);
        assert.equal(controller.shouldAdmit('p1_error'), true);
        assert.equal(controller.shouldAdmit('p2_request'), true);
        assert.equal(controller.shouldAdmit('p3_low'), true);
    });
    it('transitions to rate-limit backoff on HTTP 429 and preserves P0 while dropping P2/P3', () => {
        controller.inspectResponse(429, { 'retry-after': '60' });
        assert.equal(controller.getState(), 'QUOTA_EXHAUSTED');
        assert.equal(controller.isExhausted(), true);
        // P0 fatal/crash is NEVER dropped
        assert.equal(controller.shouldAdmit('p0_critical'), true);
        // P2 and P3 are suppressed during active 429 backoff
        assert.equal(controller.shouldAdmit('p2_request'), false);
        assert.equal(controller.shouldAdmit('p3_low'), false);
        const snapshot = controller.getSnapshot();
        assert.equal(snapshot.droppedEventsCount, 2);
    });
    it('recovers automatically when a successful 200 OK response arrives', () => {
        controller.setQuotaExhausted();
        assert.equal(controller.isExhausted(), true);
        controller.inspectResponse(200);
        assert.equal(controller.getState(), 'QUOTA_OK');
        assert.equal(controller.isExhausted(), false);
        assert.equal(controller.shouldAdmit('p2_request'), true);
    });
    it('recovers automatically when backoff window elapses without restart', async () => {
        const shortResetController = new QuotaController({ defaultResetWindowMs: 50 });
        shortResetController.setQuotaExhausted();
        assert.equal(shortResetController.isExhausted(), true);
        await new Promise(r => setTimeout(r, 80));
        assert.equal(shortResetController.getState(), 'QUOTA_OK');
        assert.equal(shortResetController.isExhausted(), false);
        shortResetController.destroy();
    });
    it('ignores backend billing headers and does not own customer quota accounting', () => {
        controller.inspectResponse(200, {
            'x-pulse-quota-limit': '10000',
            'x-pulse-quota-remaining': '250',
            'x-pulse-quota-status': 'near_limit',
            'x-pulse-quota-reset': '1700000000',
        });
        const snapshot = controller.getSnapshot();
        // SDK does NOT enter near_limit billing state
        assert.equal(snapshot.state, 'QUOTA_OK');
        // Billing accounting metrics are null (backend is single source of truth)
        assert.equal(snapshot.quotaLimit, null);
        assert.equal(snapshot.quotaRemaining, null);
        assert.equal(snapshot.quotaUsed, null);
        assert.equal(snapshot.quotaResetAt, null);
    });
    it('does not treat HTTP 402 as a client-side quota exhaustion state', () => {
        // HTTP 402 is handled as a standard non-retryable response by transport,
        // not as an internal SDK quota state machine transition.
        controller.inspectResponse(402);
        assert.equal(controller.getState(), 'QUOTA_OK');
        assert.equal(controller.isExhausted(), false);
        assert.equal(controller.shouldAdmit('p1_error'), true);
    });
    it('test_quota_error_admission_hierarchy: verifies P0 fatal crash admission vs P1 handled error shedding under QUOTA_EXHAUSTED', () => {
        controller.setQuotaExhausted('backend_rate_limited');
        assert.equal(controller.isExhausted(), true);
        // P0 fatal crash is strongly preserved and admitted
        assert.equal(controller.shouldAdmit('p0_critical'), true, 'P0 fatal crashes must NEVER be dropped');
        // Handled errors (P1), requests (P2), logs (P3) are shed during exhaustion
        assert.equal(controller.shouldAdmit('p1_error'), false, 'P1 handled errors must be shed to protect memory');
        assert.equal(controller.shouldAdmit('p2_request'), false, 'P2 requests must be shed');
        assert.equal(controller.shouldAdmit('p3_low'), false, 'P3 low priority must be shed');
        const snapshot = controller.getSnapshot();
        assert.equal(snapshot.droppedEventsCount, 3);
        assert.deepEqual(snapshot.droppedByPriority, {
            p0_critical: 0,
            p1_error: 1,
            p2_request: 1,
            p3_low: 1,
        });
        // Auto-recovery restores P1 error admission immediately
        controller.setQuotaOk('rate_limit_cleared');
        assert.equal(controller.isExhausted(), false);
        assert.equal(controller.shouldAdmit('p1_error'), true, 'P1 handled errors admitted once quota restored');
    });
});
