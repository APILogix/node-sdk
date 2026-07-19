/**
 * Public session-replay capture API.
 *
 * Emits a replay segment event (`type: 'replay'`) to the `replays`
 * ingestion route. Gated by the `sessionReplay` entitlement: when the plan
 * does not include session replay, calls are silently dropped (no-op).
 *
 * The event pipeline applies privacy scrubbing (sensitive-field redaction
 * + PII masking) to every entry in the segment before transport.
 */
import { captureEvent } from './captureEvent.js';
import { EntitlementGate } from '../core/entitlement-gate.js';
import { getLogger } from '../utils/logger.js';
import { epochMs } from '../utils/time.js';
/**
 * Capture a session-replay segment.
 *
 * @param sessionId - Replay session identifier the segment belongs to
 * @param segmentId - Monotonically increasing segment number within the session
 * @param events - Recorded replay entries (DOM mutations, interactions, …)
 *
 * No-op when the `sessionReplay` entitlement is revoked by remote config.
 */
export function captureReplay(sessionId, segmentId, events) {
    try {
        if (!EntitlementGate.isAllowed('sessionReplay'))
            return;
        if (!sessionId || events.length === 0)
            return;
        const event = {
            type: 'replay',
            sessionId,
            segmentId,
            timestamp: epochMs(),
            events,
        };
        captureEvent(event);
    }
    catch (err) {
        // Public capture APIs must never throw into user code.
        getLogger().warn('captureReplay failed', { error: err });
    }
}
//# sourceMappingURL=captureReplay.js.map