/**
 * QuotaController — Independent Telemetry Quota & Entitlement Life-Cycle Management.
 *
 * Requirements:
 * 1. Decoupled from local hardware pressure (RAM/CPU/lag).
 * 2. Manages explicit quota states: QUOTA_OK, QUOTA_NEAR_LIMIT, QUOTA_EXHAUSTED, QUOTA_RESET.
 * 3. Never kills or disables SDK instrumentation, batching, or the host application.
 * 4. Automatic recovery when reset timestamp passes or when successful server responses arrive.
 * 5. Bounded retention during exhaustion — no unbounded RAM backlogs or replay storms.
 * 6. Never requires an application or server restart to resume telemetry.
 */
import { EventEmitter } from 'node:events';
import type { QuotaState, TelemetryPriority } from '../types/telemetry-classes.js';
export interface QuotaStatusSnapshot {
    readonly state: QuotaState;
    readonly quotaLimit: number | null;
    readonly quotaUsed: number | null;
    readonly quotaRemaining: number | null;
    readonly quotaResetAt: number | null;
    readonly retryAfterMs: number | null;
    readonly droppedEventsCount: number;
    readonly isExhausted: boolean;
}
export interface QuotaControllerOptions {
    /** Optional fallback reset window if none provided by server headers. Default: 60,000ms */
    readonly defaultResetWindowMs?: number;
    /** Max high-priority events retained during quota exhaustion. Default: 200 */
    readonly maxExhaustedRetention?: number;
}
export declare class QuotaController extends EventEmitter {
    private static instance;
    private state;
    private quotaLimit;
    private quotaUsed;
    private quotaResetAt;
    private retryAfterMs;
    private droppedEventsCount;
    private recoveryTimer;
    private readonly defaultResetWindowMs;
    private readonly maxExhaustedRetention;
    private destroyed;
    constructor(options?: QuotaControllerOptions);
    static getInstance(): QuotaController;
    static reset(): void;
    getState(): QuotaState;
    isExhausted(): boolean;
    /**
     * Determine whether an event of the given priority should be admitted
     * under current quota conditions.
     *
     * - QUOTA_OK / QUOTA_NEAR_LIMIT: admits all priorities.
     * - QUOTA_EXHAUSTED: admits P0 (fatal/crash) and critical P1; suppresses P2/P3.
     */
    shouldAdmit(priority: TelemetryPriority): boolean;
    /**
     * Inspect HTTP response status and headers for quota & rate limiting signals.
     */
    inspectResponse(status: number, headers?: Headers | Record<string, string | string[] | undefined>): void;
    /**
     * Transition to QUOTA_EXHAUSTED state.
     */
    setQuotaExhausted(reason?: string): void;
    setQuotaNearLimit(): void;
    /**
     * Transition to QUOTA_OK state.
     */
    setQuotaOk(reason?: string): void;
    getSnapshot(): QuotaStatusSnapshot;
    destroy(): void;
    private checkAutoRecovery;
    private scheduleAutoRecovery;
    private clearRecoveryTimer;
}
export declare const quotaController: QuotaController;
