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
import { type CompositePressureLevel } from '../utils/adaptive-pressure.js';
import type { PressureState, TelemetryPriority } from '../types/telemetry-classes.js';
export type { TelemetryPriority };
export interface LoadShedderStats {
    readonly droppedByPriority: Record<TelemetryPriority, number>;
    readonly admittedByPriority: Record<TelemetryPriority, number>;
    readonly currentLevel: CompositePressureLevel;
    readonly currentState: PressureState;
    readonly totalShed: number;
    readonly totalAdmitted: number;
    readonly groupsAdmitted: number;
    readonly groupsShed: number;
}
/**
 * Bounded tracker for Correlation Groups (tracks error/diagnostic promotion).
 */
export declare class CorrelationGroupTracker {
    private readonly maxGroups;
    private readonly errorGroups;
    markError(groupKey: string, isFatal?: boolean): void;
    hasError(groupKey: string): boolean;
    isFatal(groupKey: string): boolean;
    clear(): void;
}
export type PressureInputState = PressureState | CompositePressureLevel;
export declare class LoadShedder {
    private readonly getPressureState;
    private droppedCounts;
    private admittedCounts;
    private totalShed;
    private totalAdmitted;
    private groupsAdmitted;
    private groupsShed;
    private readonly seenGroups;
    private readonly groupTracker;
    private pruneSeenGroups;
    constructor(getPressureState?: () => PressureInputState);
    /**
     * Extract or resolve the stable correlation group key for an event.
     * Priority: traceId > requestId > eventId.
     */
    resolveCorrelationKey(event: Record<string, unknown>): string;
    /**
     * Classify an event into an enterprise telemetry priority tier.
     */
    classifyEvent(event: Record<string, unknown>): TelemetryPriority;
    /**
     * Determine if an event should be shed based on current system pressure
     * and correlation group semantics.
     * Returns true if the event should be DROPPED.
     */
    shouldShed(event: Record<string, unknown>): boolean;
    getPressureLevel(): CompositePressureLevel;
    getStats(): LoadShedderStats;
    reset(): void;
}
export declare const loadShedder: LoadShedder;
