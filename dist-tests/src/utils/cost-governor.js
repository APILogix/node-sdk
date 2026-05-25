/**
 * Cost Governor — telemetry ingestion cost control.
 *
 * Protects against:
 * - Span explosion (too many spans per trace)
 * - Metric instrument explosion
 * - Payload amplification (bytes budget)
 * - Unbounded ingestion costs
 *
 * Enterprise observability platforms charge by volume. The SDK must
 * self-govern to prevent bill shock during incidents.
 */
import { getLogger } from './logger.js';
import { epochMs } from './time.js';
// ─── Implementation ─────────────────────────────────────────────────────────
export class CostGovernor {
    maxSpansPerTrace;
    maxActiveInstruments;
    bytesBudgetPerMinute;
    enableAdaptiveReduction;
    maxTraceDurationMs;
    // Span tracking per trace: Map<traceId, spanCount>
    traceSpanCounts = new Map();
    traceTimestamps = new Map();
    maxTrackedTraces = 10_000;
    // Bytes tracking — sliding window (60s)
    byteWindows = [];
    windowDurationMs = 60_000;
    // Stats
    totalBytesSent = 0;
    totalSpansBlocked = 0;
    totalBudgetExceeded = 0;
    // Cleanup timer
    cleanupTimer = null;
    constructor(options = {}) {
        this.maxSpansPerTrace = options.maxSpansPerTrace ?? 1000;
        this.maxActiveInstruments = options.maxActiveInstruments ?? 200;
        this.bytesBudgetPerMinute = options.bytesBudgetPerMinute ?? 10 * 1024 * 1024; // 10MB
        this.enableAdaptiveReduction = options.enableAdaptiveReduction ?? true;
        this.maxTraceDurationMs = options.maxTraceDurationMs ?? 300_000; // 5 minutes
        this.cleanupTimer = setInterval(() => this.cleanup(), 30_000);
        this.cleanupTimer.unref();
    }
    /**
     * Update cost governor limits from remote config.
     * Called when remote config is loaded or changes at runtime.
     */
    updateFromConfig(options) {
        if (options.maxSpansPerTrace !== undefined) {
            this.maxSpansPerTrace = options.maxSpansPerTrace;
        }
        if (options.maxTraceDurationMs !== undefined) {
            this.maxTraceDurationMs = options.maxTraceDurationMs;
        }
        getLogger().debug('Cost governor updated from config', {
            maxSpansPerTrace: this.maxSpansPerTrace,
            maxTraceDurationMs: this.maxTraceDurationMs,
        });
    }
    /**
     * Check if a new span can be created for the given trace.
     * Returns false if the trace has exceeded its span limit.
     */
    canCreateSpan(traceId) {
        const current = this.traceSpanCounts.get(traceId) ?? 0;
        if (current >= this.maxSpansPerTrace) {
            this.totalSpansBlocked++;
            if (current === this.maxSpansPerTrace) {
                getLogger().warn('Span limit reached for trace', {
                    traceId: traceId.slice(0, 8) + '...',
                    maxSpans: this.maxSpansPerTrace,
                });
            }
            return false;
        }
        this.traceSpanCounts.set(traceId, current + 1);
        if (!this.traceTimestamps.has(traceId)) {
            this.traceTimestamps.set(traceId, epochMs());
        }
        // LRU eviction when tracking too many traces
        if (this.traceSpanCounts.size > this.maxTrackedTraces) {
            this.evictOldestTraces();
        }
        return true;
    }
    /**
     * Check if a trace can continue based on its duration.
     * Returns false if the trace has exceeded maxTraceDurationMs.
     */
    canContinueTrace(traceId) {
        const startTime = this.traceTimestamps.get(traceId);
        if (startTime === undefined)
            return true; // Unknown trace — allow
        const elapsed = epochMs() - startTime;
        if (elapsed > this.maxTraceDurationMs) {
            getLogger().warn('Trace exceeded max duration', {
                traceId: traceId.slice(0, 8) + '...',
                elapsed,
                maxDurationMs: this.maxTraceDurationMs,
            });
            return false;
        }
        return true;
    }
    /**
     * Record bytes sent for budget tracking.
     */
    recordBytesSent(bytes) {
        const now = epochMs();
        this.byteWindows.push({ timestamp: now, bytes });
        this.totalBytesSent += bytes;
        // Check budget
        const currentRate = this.getCurrentBytesPerMinute();
        if (currentRate > this.bytesBudgetPerMinute) {
            this.totalBudgetExceeded++;
            if (this.totalBudgetExceeded % 10 === 1) {
                getLogger().warn('Telemetry bytes budget exceeded', {
                    currentRate: (currentRate / 1024 / 1024).toFixed(2) + 'MB/min',
                    budget: (this.bytesBudgetPerMinute / 1024 / 1024).toFixed(2) + 'MB/min',
                });
            }
        }
    }
    /**
     * Get current cost utilization.
     */
    getUtilization() {
        const bytesPerMinute = this.getCurrentBytesPerMinute();
        const budgetUtilization = this.bytesBudgetPerMinute > 0
            ? bytesPerMinute / this.bytesBudgetPerMinute
            : 0;
        return {
            bytesPerMinute,
            budgetUtilization,
            activeTraces: this.traceSpanCounts.size,
            shouldReduce: this.shouldReduceTelemetry(),
        };
    }
    /**
     * Should the SDK reduce telemetry volume?
     * Returns true when approaching budget limits.
     */
    shouldReduceTelemetry() {
        if (!this.enableAdaptiveReduction)
            return false;
        const utilization = this.getCurrentBytesPerMinute() / this.bytesBudgetPerMinute;
        return utilization > 0.8;
    }
    getStats() {
        const currentBytesPerMinute = this.getCurrentBytesPerMinute();
        return {
            totalBytesSent: this.totalBytesSent,
            totalSpansBlocked: this.totalSpansBlocked,
            totalBudgetExceeded: this.totalBudgetExceeded,
            currentBytesPerMinute,
            budgetUtilization: this.bytesBudgetPerMinute > 0
                ? currentBytesPerMinute / this.bytesBudgetPerMinute
                : 0,
        };
    }
    reset() {
        this.traceSpanCounts.clear();
        this.traceTimestamps.clear();
        this.byteWindows.length = 0;
        this.totalBytesSent = 0;
        this.totalSpansBlocked = 0;
        this.totalBudgetExceeded = 0;
    }
    shutdown() {
        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer);
            this.cleanupTimer = null;
        }
    }
    // ─── Internal ───────────────────────────────────────────────────────────
    getCurrentBytesPerMinute() {
        const now = epochMs();
        const cutoff = now - this.windowDurationMs;
        // Clean expired entries
        while (this.byteWindows.length > 0 && (this.byteWindows[0]?.timestamp ?? 0) < cutoff) {
            this.byteWindows.shift();
        }
        let total = 0;
        for (const entry of this.byteWindows) {
            total += entry.bytes;
        }
        return total;
    }
    evictOldestTraces() {
        // Remove oldest 10% of tracked traces
        const toRemove = Math.floor(this.maxTrackedTraces * 0.1);
        const sorted = [...this.traceTimestamps.entries()]
            .sort((a, b) => a[1] - b[1])
            .slice(0, toRemove);
        for (const [traceId] of sorted) {
            this.traceSpanCounts.delete(traceId);
            this.traceTimestamps.delete(traceId);
        }
    }
    cleanup() {
        const now = epochMs();
        const traceMaxAge = 300_000; // 5 minutes
        // Clean old traces
        for (const [traceId, timestamp] of this.traceTimestamps.entries()) {
            if (now - timestamp > traceMaxAge) {
                this.traceSpanCounts.delete(traceId);
                this.traceTimestamps.delete(traceId);
            }
        }
        // Clean old byte windows
        const cutoff = now - this.windowDurationMs;
        while (this.byteWindows.length > 0 && (this.byteWindows[0]?.timestamp ?? 0) < cutoff) {
            this.byteWindows.shift();
        }
    }
}
// ─── Singleton ──────────────────────────────────────────────────────────────
export const costGovernor = new CostGovernor();
