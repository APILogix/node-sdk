/**
 * Adaptive Load Shedder — graceful degradation during overload.
 *
 * Classifies telemetry events by priority and sheds them based on
 * the current system pressure level from AdaptivePressureMonitor.
 *
 * Priority levels:
 *   P0 (never drop): uncaughtException, unhandledRejection, OOM
 *   P1 (drop last): errors with stack traces
 *   P2 (drop early): request events, spans
 *   P3 (drop first): messages, metrics, breadcrumbs
 *
 * Shedding behavior by pressure level:
 *   normal:   shed nothing
 *   elevated: shed nothing (warning logged)
 *   high:     shed P3 events
 *   critical: shed P3 + P2, only P0 + P1 survive
 */
import { getLogger } from '../utils/logger.js';
import { adaptivePressure } from '../utils/adaptive-pressure.js';
// ─── Implementation ─────────────────────────────────────────────────────────
export class LoadShedder {
    droppedCounts = {
        p0_critical: 0,
        p1_error: 0,
        p2_request: 0,
        p3_low: 0,
    };
    totalShed = 0;
    /**
     * Classify an event into a telemetry priority tier.
     */
    classifyEvent(event) {
        const type = event['type'];
        const mechanism = event['mechanism'];
        // P0: unhandled errors (crashes, OOM)
        if (type === 'error') {
            const mechanismType = mechanism?.['type'];
            if (mechanismType === 'uncaughtException' ||
                mechanismType === 'unhandledRejection' ||
                mechanismType === 'onunhandledrejection' ||
                mechanismType === 'onerror') {
                return 'p0_critical';
            }
            return 'p1_error';
        }
        // P2: requests and spans (important but sheddable)
        if (type === 'request' || type === 'span') {
            return 'p2_request';
        }
        // P3: everything else (metrics, messages, breadcrumbs)
        return 'p3_low';
    }
    /**
     * Determine if an event should be shed based on current pressure.
     * Returns true if the event should be DROPPED.
     */
    shouldShed(event) {
        const priority = this.classifyEvent(event);
        const pressureLevel = adaptivePressure.getLevel();
        let shed = false;
        switch (pressureLevel) {
            case 'normal':
                shed = false;
                break;
            case 'elevated':
                // Warning only — don't shed yet
                shed = false;
                break;
            case 'high':
                // Shed low-priority
                shed = priority === 'p3_low';
                break;
            case 'critical':
                // Only P0 and P1 survive
                shed = priority === 'p3_low' || priority === 'p2_request';
                break;
        }
        if (shed) {
            this.droppedCounts[priority]++;
            this.totalShed++;
            if (this.totalShed % 100 === 1) {
                getLogger().warn('Load shedder active — dropping telemetry', {
                    priority,
                    pressureLevel,
                    totalShed: this.totalShed,
                });
            }
        }
        return shed;
    }
    getStats() {
        return {
            droppedByPriority: { ...this.droppedCounts },
            currentLevel: adaptivePressure.getLevel(),
            totalShed: this.totalShed,
        };
    }
    reset() {
        this.droppedCounts = {
            p0_critical: 0,
            p1_error: 0,
            p2_request: 0,
            p3_low: 0,
        };
        this.totalShed = 0;
    }
}
// ─── Singleton ──────────────────────────────────────────────────────────────
export const loadShedder = new LoadShedder();
