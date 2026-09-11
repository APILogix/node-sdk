/**
 * Persistence Governor — priority-aware, adaptive persistence governance.
 *
 * Controls which events are persisted to disk for crash recovery based on:
 *   - Event durability tier (critical / important / transient)
 *   - Current system pressure level (normal / elevated / high / critical)
 *   - Per-minute persist budget (prevents runaway disk I/O)
 *
 * Durability tiers:
 *   critical:   errors, crashes, unhandled exceptions → ALWAYS persist
 *   important:  spans, requests → persist under normal/elevated pressure
 *   transient:  metrics, messages → persist only under normal pressure
 *
 * Behavior matrix:
 *   ┌──────────────┬─────────┬──────────┬──────────┬──────────┐
 *   │ Tier         │ Normal  │ Elevated │ High     │ Critical │
 *   ├──────────────┼─────────┼──────────┼──────────┼──────────┤
 *   │ critical     │ ✅       │ ✅        │ ✅        │ ✅        │
 *   │ important    │ ✅       │ ✅        │ 50%      │ ❌        │
 *   │ transient    │ ✅       │ 50%      │ ❌        │ ❌        │
 *   └──────────────┴─────────┴──────────┴──────────┴──────────┘
 *
 * The 50% sampling is deterministic (hash-based on eventId) so the same
 * event always gets the same persist/skip decision across restarts.
 *
 * Enterprise observability SDKs (Datadog, Sentry) use similar tiered
 * durability — this prevents disk I/O from becoming a throughput bottleneck
 * while preserving crash recovery for high-value telemetry.
 */
import type { Event } from '../types/event.js';
import type { PersistenceGovernanceConfig } from '../types/config.js';
export type DurabilityTier = 'critical' | 'important' | 'transient';
export interface PersistenceGovernorOptions {
    /** Max events to persist per minute. Default: 20000 */
    readonly maxPersistPerMinute?: number;
    /** Enable adaptive persistence reduction under pressure. Default: true */
    readonly enableAdaptive?: boolean;
    /** Minimum interval between aggregated budget-exceeded warnings. Default: 60000 */
    readonly budgetExceededLogIntervalMs?: number;
}
export interface PersistenceStats {
    readonly totalEvaluated: number;
    readonly totalPersisted: number;
    readonly totalSkipped: number;
    readonly skippedByTier: Record<DurabilityTier, number>;
    readonly skippedByBudget: number;
    readonly currentPersistRate: number;
    readonly budgetUtilization: number;
}
export declare class PersistenceGovernor {
    private maxPersistPerMinute;
    private enableAdaptive;
    private budgetExceededLogIntervalMs;
    private readonly persistWindows;
    private readonly windowDurationMs;
    private totalEvaluated;
    private totalPersisted;
    private totalSkipped;
    private skippedByTier;
    private skippedByBudget;
    private skippedSinceLastBudgetLog;
    private lastBudgetExceededLogAt;
    constructor(options?: PersistenceGovernorOptions);
    /**
     * Apply the backend-owned persistence governance policy from remote config.
     * No SDK init option can override this.
     */
    configure(config: PersistenceGovernanceConfig): void;
    /**
     * Determine if an event should be persisted to disk.
     *
     * Decision factors:
     *   1. Durability tier (based on event type)
     *   2. Current adaptive pressure level
     *   3. Per-minute persist budget
     *
     * Critical events (errors/crashes) ALWAYS persist regardless of pressure or budget.
     */
    shouldPersist(event: Event): boolean;
    /**
     * Classify an event into a durability tier.
     *
     * - critical: errors, unhandled exceptions — must survive crashes
     * - important: spans, requests — valuable for debugging but sheddable
     * - transient: metrics, messages — easily re-emitted, lowest priority
     */
    classifyDurability(event: Event): DurabilityTier;
    getStats(): PersistenceStats;
    reset(): void;
    private evaluatePressureMatrix;
    /**
     * Deterministic sampling based on eventId hash.
     * The same eventId always gets the same persist/skip decision.
     * This prevents non-deterministic replay behavior.
     */
    private deterministicSample;
    private isOverBudget;
    private getCurrentPersistRate;
    private recordPersist;
}
export declare const persistenceGovernor: PersistenceGovernor;
