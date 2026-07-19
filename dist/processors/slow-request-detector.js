/**
 * @deprecated — REMOVED in v3.0
 *
 * The SDK-side slow request detector has been permanently removed.
 * Slow request detection is now handled entirely on the backend using
 * OTel http.server.duration latency histograms.
 *
 * Backend-side detection provides:
 * - Zero SDK CPU overhead (no timer loops, no per-route Maps)
 * - Statistical accuracy (ExponentialHistogram → true p99)
 * - Centralized threshold management (change thresholds without redeploy)
 * - Cross-service correlation (slow upstreams → downstream latency)
 * - Anomaly detection with ML (not possible SDK-side)
 *
 * How it works:
 *   OTel auto-instrumentation records http.server.duration → ExponentialHistogram
 *   → Pulse backend queries: WHERE percentile(http.server.duration, 0.99) > threshold
 *   → Backend triggers alerts/anomaly detection
 *
 * This file is a BACKWARD-COMPATIBLE STUB. All methods are no-ops.
 * It will be fully removed in the next major version.
 */
import { getLogger } from '../utils/logger.js';
let deprecationWarned = false;
class SlowRequestDetector {
    configure(_options) {
        if (!deprecationWarned) {
            deprecationWarned = true;
            getLogger().warn('SlowRequestDetector is deprecated and has been removed in v3.0. ' +
                'Slow request detection is now handled by the backend using OTel ' +
                'http.server.duration latency histograms. This call is a no-op.');
        }
    }
    check(_options) {
        return false;
    }
    getStats() {
        return {
            initialized: false,
            totalChecked: 0,
            totalSlow: 0,
            slowRate: 0,
            trackedRoutes: 0,
            topSlowRoutes: [],
        };
    }
    reset() {
        // no-op
    }
}
export const slowRequestDetector = new SlowRequestDetector();
export { SlowRequestDetector };
//# sourceMappingURL=slow-request-detector.js.map