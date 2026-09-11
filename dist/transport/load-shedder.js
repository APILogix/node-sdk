/**
 * Adaptive Load Shedder & Correlation Group Admission Controller.
 *
 * Requirements:
 * 1. Priority-aware admission: P0 (never drop), P1 (errors + correlated context), P2 (requests/spans), P3 (low-value).
 * 2. Correlation-Group Admission: Makes admission decisions at the correlation-group level (traceId/requestId).
 *    Never produces orphan errors or broken traces (request without spans, span without parent).
 * 3. 5-State Pressure Integration: HEALTHY, ELEVATED, PRESSURED, CRITICAL, RECOVERING.
 * 4. Deterministic Group-Level Sampling: If sampling is applied under pressure, all events in a trace/request
 *    share the same group hash and survive or shed as a unified diagnostic unit.
 * 5. Degradation Metadata: Explicitly tags degraded telemetry so backend/UI distinguishes intentional shedding.
 * 6. Operational Metrics: Exposes full counters for admissions, shedding, priority drops, and group decisions.
 */
import { adaptivePressure } from '../utils/adaptive-pressure.js';
import { getLogger } from '../utils/logger.js';
const CRITICAL_P2_GROUP_KEEP_RATE = 0.10;
/**
 * Bounded tracker for Correlation Groups (tracks error/diagnostic promotion).
 */
class CorrelationGroupTracker {
    maxGroups = 5_000;
    errorGroups = new Map();
    markError(groupKey, isFatal = false) {
        if (!groupKey)
            return;
        this.errorGroups.set(groupKey, { timestamp: Date.now(), fatal: isFatal });
        if (this.errorGroups.size > this.maxGroups) {
            // Evict oldest 500 entries
            const iterator = this.errorGroups.keys();
            for (let i = 0; i < 500; i++) {
                const next = iterator.next();
                if (next.done)
                    break;
                this.errorGroups.delete(next.value);
            }
        }
    }
    hasError(groupKey) {
        if (!groupKey)
            return false;
        const entry = this.errorGroups.get(groupKey);
        if (!entry)
            return false;
        // Retain error promotion for 5 minutes
        if (Date.now() - entry.timestamp > 300_000) {
            this.errorGroups.delete(groupKey);
            return false;
        }
        return true;
    }
    isFatal(groupKey) {
        if (!groupKey)
            return false;
        const entry = this.errorGroups.get(groupKey);
        return Boolean(entry?.fatal);
    }
    clear() {
        this.errorGroups.clear();
    }
}
export class LoadShedder {
    getPressureState;
    droppedCounts = {
        p0_critical: 0,
        p1_error: 0,
        p2_request: 0,
        p3_low: 0,
    };
    admittedCounts = {
        p0_critical: 0,
        p1_error: 0,
        p2_request: 0,
        p3_low: 0,
    };
    totalShed = 0;
    totalAdmitted = 0;
    groupsAdmitted = 0;
    groupsShed = 0;
    groupTracker = new CorrelationGroupTracker();
    constructor(getPressureState = () => adaptivePressure.getState()) {
        this.getPressureState = getPressureState;
    }
    /**
     * Extract or resolve the stable correlation group key for an event.
     * Priority: traceId > requestId > eventId.
     */
    resolveCorrelationKey(event) {
        const traceId = event['traceId'];
        if (typeof traceId === 'string' && traceId.trim())
            return traceId.trim();
        const requestId = event['requestId'];
        if (typeof requestId === 'string' && requestId.trim())
            return requestId.trim();
        const spanContext = event['spanContext'];
        if (typeof spanContext?.traceId === 'string' && spanContext.traceId.trim()) {
            return spanContext.traceId.trim();
        }
        const eventId = event['eventId'];
        if (typeof eventId === 'string' && eventId.trim())
            return eventId.trim();
        return '';
    }
    /**
     * Classify an event into an enterprise telemetry priority tier.
     */
    classifyEvent(event) {
        const type = event['type'];
        const mechanism = event['mechanism'];
        const severity = event['severity'];
        const level = event['level'];
        const groupKey = this.resolveCorrelationKey(event);
        // P0: Uncaught / Fatal exceptions, process crashes, fatal logs
        if (type === 'error') {
            const mechanismType = typeof mechanism === 'object' && mechanism !== null
                ? mechanism['type']
                : typeof mechanism === 'string' ? mechanism : undefined;
            if (severity === 'fatal' ||
                mechanismType === 'uncaughtException' ||
                mechanismType === 'unhandledRejection' ||
                mechanismType === 'onunhandledrejection' ||
                mechanismType === 'onerror') {
                if (groupKey)
                    this.groupTracker.markError(groupKey, true);
                return 'p0_critical';
            }
            if (groupKey)
                this.groupTracker.markError(groupKey, false);
            return 'p1_error';
        }
        if (type === 'log') {
            if (level === 'fatal')
                return 'p0_critical';
            if (level === 'error') {
                if (groupKey)
                    this.groupTracker.markError(groupKey, false);
                return 'p1_error';
            }
        }
        if (type === 'cron_checkin' && event['status'] === 'error') {
            return 'p1_error';
        }
        // If this event belongs to a correlation group with an active error/crash,
        // promote requests and spans to P1 so the diagnostic context is preserved!
        if (groupKey && this.groupTracker.hasError(groupKey)) {
            if (type === 'request' || type === 'span' || type === 'trace') {
                return 'p1_error';
            }
        }
        // P2: Normal HTTP requests, distributed traces, and spans
        if (type === 'request' || type === 'span' || type === 'trace') {
            return 'p2_request';
        }
        // P3: Low-value diagnostic telemetry (messages, metrics, breadcrumbs, logs)
        return 'p3_low';
    }
    /**
     * Determine if an event should be shed based on current system pressure
     * and correlation group semantics.
     * Returns true if the event should be DROPPED.
     */
    shouldShed(event) {
        const priority = this.classifyEvent(event);
        const rawState = this.getPressureState();
        const state = normalizePressureState(rawState);
        const groupKey = this.resolveCorrelationKey(event);
        let shed = false;
        switch (state) {
            case 'HEALTHY':
                shed = false;
                break;
            case 'ELEVATED':
                // Warning state — shed nothing to preserve full fidelity
                shed = false;
                break;
            case 'PRESSURED':
                // Shed low-priority telemetry (P3); preserve all P0, P1, and correlated P2 groups
                shed = priority === 'p3_low';
                break;
            case 'CRITICAL':
                // In CRITICAL pressure, protect the application:
                // 1. P0 (fatal/crash) NEVER dropped.
                // 2. P1 (errors + correlated trace context) ALWAYS preserved.
                // 3. P3 (low-value) 100% shed.
                // 4. P2 (non-error requests/spans) keeps a deterministic group-level sample
                //    (all spans & requests in the same trace make the same admission decision).
                if (priority === 'p0_critical' || priority === 'p1_error') {
                    shed = false;
                }
                else if (priority === 'p3_low') {
                    shed = true;
                }
                else if (priority === 'p2_request') {
                    const sampleKey = groupKey || stableFallbackKey(event);
                    const keepGroup = keepDeterministicGroupSample(sampleKey, CRITICAL_P2_GROUP_KEEP_RATE);
                    shed = !keepGroup;
                }
                break;
            case 'RECOVERING':
                // In RECOVERING state, shed low-priority (P3) to prevent backlog storm,
                // but preserve P0, P1, P2.
                shed = priority === 'p3_low';
                break;
        }
        if (shed) {
            this.droppedCounts[priority]++;
            this.totalShed++;
            if (groupKey)
                this.groupsShed++;
            if (this.totalShed % 100 === 1) {
                getLogger().warn('Load shedder active — dropping telemetry', {
                    priority,
                    pressureLevel: this.getPressureLevel(),
                    pressureState: state,
                    totalShed: this.totalShed,
                });
            }
        }
        else {
            this.admittedCounts[priority]++;
            this.totalAdmitted++;
            if (groupKey)
                this.groupsAdmitted++;
            // Tag event with degradation metadata if operating under pressure
            if (state === 'CRITICAL' || state === 'PRESSURED') {
                event['telemetry_degraded'] = true;
                event['pressure_level'] = state;
                if (priority === 'p2_request') {
                    event['sampling_reason'] = 'pressure_group_sampled';
                }
            }
        }
        return shed;
    }
    getPressureLevel() {
        return adaptivePressure.getLevel();
    }
    getStats() {
        return {
            droppedByPriority: { ...this.droppedCounts },
            admittedByPriority: { ...this.admittedCounts },
            currentLevel: this.getPressureLevel(),
            currentState: normalizePressureState(this.getPressureState()),
            totalShed: this.totalShed,
            totalAdmitted: this.totalAdmitted,
            groupsAdmitted: this.groupsAdmitted,
            groupsShed: this.groupsShed,
        };
    }
    reset() {
        this.droppedCounts = {
            p0_critical: 0,
            p1_error: 0,
            p2_request: 0,
            p3_low: 0,
        };
        this.admittedCounts = {
            p0_critical: 0,
            p1_error: 0,
            p2_request: 0,
            p3_low: 0,
        };
        this.totalShed = 0;
        this.totalAdmitted = 0;
        this.groupsAdmitted = 0;
        this.groupsShed = 0;
        this.groupTracker.clear();
    }
}
// ─── Singleton ──────────────────────────────────────────────────────────────
export const loadShedder = new LoadShedder();
// ─── Deterministic Correlation Group Hashing ────────────────────────────────
function keepDeterministicGroupSample(groupKey, rate) {
    if (rate >= 1)
        return true;
    if (rate <= 0)
        return false;
    return hashToUnitInterval(groupKey) < rate;
}
function stableFallbackKey(event) {
    const type = event['type'];
    const timestamp = event['timestamp'];
    return `${typeof type === 'string' ? type : 'unknown'}:${typeof timestamp === 'number' ? timestamp : Date.now()}`;
}
function hashToUnitInterval(value) {
    let hash = 0x811c9dc5;
    for (let index = 0; index < value.length; index++) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0) / 0x100000000;
}
function normalizePressureState(raw) {
    if (raw === 'HEALTHY' || raw === 'normal' || raw === 'healthy')
        return 'HEALTHY';
    if (raw === 'ELEVATED' || raw === 'elevated')
        return 'ELEVATED';
    if (raw === 'PRESSURED' || raw === 'high' || raw === 'pressured')
        return 'PRESSURED';
    if (raw === 'CRITICAL' || raw === 'critical')
        return 'CRITICAL';
    if (raw === 'RECOVERING' || raw === 'recovering')
        return 'RECOVERING';
    return 'HEALTHY';
}
