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
import { adaptivePressure } from '../utils/adaptive-pressure.js';
import { getLogger } from '../utils/logger.js';
import { epochMs } from '../utils/time.js';
// ─── Implementation ─────────────────────────────────────────────────────────
const DEFAULT_MAX_PERSIST_PER_MINUTE = 20_000;
const DEFAULT_BUDGET_EXCEEDED_LOG_INTERVAL_MS = 60_000;
export class PersistenceGovernor {
    maxPersistPerMinute;
    enableAdaptive;
    budgetExceededLogIntervalMs;
    // Sliding window for per-minute budget tracking
    persistWindows = [];
    windowDurationMs = 60_000;
    // Stats
    totalEvaluated = 0;
    totalPersisted = 0;
    totalSkipped = 0;
    skippedByTier = {
        critical: 0,
        important: 0,
        transient: 0,
    };
    skippedByBudget = 0;
    skippedSinceLastBudgetLog = 0;
    lastBudgetExceededLogAt = 0;
    constructor(options = {}) {
        this.maxPersistPerMinute = options.maxPersistPerMinute ?? DEFAULT_MAX_PERSIST_PER_MINUTE;
        this.enableAdaptive = options.enableAdaptive ?? true;
        this.budgetExceededLogIntervalMs = options.budgetExceededLogIntervalMs ?? DEFAULT_BUDGET_EXCEEDED_LOG_INTERVAL_MS;
    }
    /**
     * Apply the backend-owned persistence governance policy from remote config.
     * No SDK init option can override this.
     */
    configure(config) {
        this.maxPersistPerMinute = config.maxPersistPerMinute;
        this.enableAdaptive = config.adaptive;
        this.budgetExceededLogIntervalMs = config.budgetExceededLogIntervalMs;
        getLogger().debug('Persistence governor configured from remote config', {
            adaptive: this.enableAdaptive,
        });
    }
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
    shouldPersist(event) {
        this.totalEvaluated++;
        const tier = this.classifyDurability(event);
        const pressure = this.enableAdaptive ? adaptivePressure.getLevel() : 'normal';
        // Critical tier: always persist — crash recovery is non-negotiable
        if (tier === 'critical') {
            this.recordPersist();
            return true;
        }
        // Budget check (skip for critical tier above)
        if (this.isOverBudget()) {
            this.skippedByBudget++;
            this.totalSkipped++;
            this.skippedSinceLastBudgetLog++;
            const now = epochMs();
            if (now - this.lastBudgetExceededLogAt >= this.budgetExceededLogIntervalMs) {
                getLogger().warn('Persistence governor: persist budget exceeded', {
                    utilization: this.maxPersistPerMinute > 0
                        ? Math.round((this.getCurrentPersistRate() / this.maxPersistPerMinute) * 100) / 100
                        : 0,
                    skippedSinceLastLog: this.skippedSinceLastBudgetLog,
                    tier,
                    pressure,
                });
                this.skippedSinceLastBudgetLog = 0;
                this.lastBudgetExceededLogAt = now;
            }
            return false;
        }
        // Adaptive pressure matrix
        const shouldPersist = this.evaluatePressureMatrix(tier, pressure, event);
        if (shouldPersist) {
            this.recordPersist();
        }
        else {
            this.skippedByTier[tier]++;
            this.totalSkipped++;
        }
        return shouldPersist;
    }
    /**
     * Classify an event into a durability tier.
     *
     * - critical: errors, unhandled exceptions — must survive crashes
     * - important: spans, requests — valuable for debugging but sheddable
     * - transient: metrics, messages — easily re-emitted, lowest priority
     */
    classifyDurability(event) {
        const type = event.type;
        if (type === 'error') {
            return 'critical';
        }
        if (type === 'request' || type === 'span') {
            return 'important';
        }
        // metrics, messages, and anything else
        return 'transient';
    }
    getStats() {
        return {
            totalEvaluated: this.totalEvaluated,
            totalPersisted: this.totalPersisted,
            totalSkipped: this.totalSkipped,
            skippedByTier: { ...this.skippedByTier },
            skippedByBudget: this.skippedByBudget,
            currentPersistRate: this.getCurrentPersistRate(),
            budgetUtilization: this.maxPersistPerMinute > 0
                ? this.getCurrentPersistRate() / this.maxPersistPerMinute
                : 0,
        };
    }
    reset() {
        this.totalEvaluated = 0;
        this.totalPersisted = 0;
        this.totalSkipped = 0;
        this.skippedByTier = { critical: 0, important: 0, transient: 0 };
        this.skippedByBudget = 0;
        this.skippedSinceLastBudgetLog = 0;
        this.lastBudgetExceededLogAt = 0;
        this.persistWindows.length = 0;
    }
    // ─── Internal ─────────────────────────────────────────────────────────
    evaluatePressureMatrix(tier, pressure, event) {
        switch (pressure) {
            case 'normal':
                // All tiers persist under normal pressure
                return true;
            case 'elevated':
                if (tier === 'important')
                    return true;
                if (tier === 'transient')
                    return this.deterministicSample(event, 0.5);
                return true;
            case 'high':
                if (tier === 'important')
                    return this.deterministicSample(event, 0.5);
                if (tier === 'transient')
                    return false;
                return true;
            case 'critical':
                // Only critical tier persists (handled above in shouldPersist)
                // important and transient are skipped
                return false;
            default:
                return true;
        }
    }
    /**
     * Deterministic sampling based on eventId hash.
     * The same eventId always gets the same persist/skip decision.
     * This prevents non-deterministic replay behavior.
     */
    deterministicSample(event, rate) {
        const id = event.eventId ?? '';
        if (!id)
            return rate > 0.5; // fallback for events without IDs
        // Simple deterministic hash: sum char codes modulo 100
        let hash = 0;
        for (let i = 0; i < id.length; i++) {
            hash = (hash * 31 + id.charCodeAt(i)) | 0;
        }
        return (Math.abs(hash) % 100) < (rate * 100);
    }
    isOverBudget() {
        return this.getCurrentPersistRate() >= this.maxPersistPerMinute;
    }
    getCurrentPersistRate() {
        const now = epochMs();
        const cutoff = now - this.windowDurationMs;
        // Clean expired entries
        while (this.persistWindows.length > 0 && (this.persistWindows[0]?.timestamp ?? 0) < cutoff) {
            this.persistWindows.shift();
        }
        return this.persistWindows.length;
    }
    recordPersist() {
        this.persistWindows.push({ timestamp: epochMs() });
        this.totalPersisted++;
    }
}
// ─── Singleton ──────────────────────────────────────────────────────────────
export const persistenceGovernor = new PersistenceGovernor();
