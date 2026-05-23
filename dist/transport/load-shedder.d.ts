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
import { type CompositePressureLevel } from '../utils/adaptive-pressure.js';
export type TelemetryPriority = 'p0_critical' | 'p1_error' | 'p2_request' | 'p3_low';
export interface LoadShedderStats {
    readonly droppedByPriority: Record<TelemetryPriority, number>;
    readonly currentLevel: CompositePressureLevel;
    readonly totalShed: number;
}
export declare class LoadShedder {
    private droppedCounts;
    private totalShed;
    /**
     * Classify an event into a telemetry priority tier.
     */
    classifyEvent(event: Record<string, unknown>): TelemetryPriority;
    /**
     * Determine if an event should be shed based on current pressure.
     * Returns true if the event should be DROPPED.
     */
    shouldShed(event: Record<string, unknown>): boolean;
    getStats(): LoadShedderStats;
    reset(): void;
}
export declare const loadShedder: LoadShedder;
//# sourceMappingURL=load-shedder.d.ts.map