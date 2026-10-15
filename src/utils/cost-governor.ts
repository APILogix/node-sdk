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

import { getLogger } from './logger.js'
import { epochMs } from './time.js'

// ─── Types ──────────────────────────────────────────────────────────────────

export interface CostGovernorOptions {
    /** Max spans allowed per trace. Default: 1000 */
    readonly maxSpansPerTrace?: number
    /** Max active metric instruments. Default: 200 */
    readonly maxActiveInstruments?: number
    /** Bytes budget per minute. Default: 10MB */
    readonly bytesBudgetPerMinute?: number
    /** Enable adaptive telemetry reduction when approaching budget. Default: true */
    readonly enableAdaptiveReduction?: boolean
    /** Max duration of a single trace in milliseconds. Default: 300000 (5 minutes) */
    readonly maxTraceDurationMs?: number
}

export interface CostUtilization {
    readonly bytesPerMinute: number
    readonly budgetUtilization: number
    readonly activeTraces: number
    readonly shouldReduce: boolean
}

export interface CostStats {
    readonly totalBytesSent: number
    readonly totalSpansBlocked: number
    readonly totalBudgetExceeded: number
    readonly currentBytesPerMinute: number
    readonly budgetUtilization: number
}

// ─── Implementation ─────────────────────────────────────────────────────────

export class CostGovernor {
    private maxSpansPerTrace: number
    private readonly maxActiveInstruments: number
    private readonly bytesBudgetPerMinute: number
    private readonly enableAdaptiveReduction: boolean
    private maxTraceDurationMs: number

    // Span tracking per trace: Map<traceId, spanCount>
    private readonly traceSpanCounts = new Map<string, number>()
    private readonly traceTimestamps = new Map<string, number>()
    private readonly maxTrackedTraces = 2_000

    // Bytes tracking — sliding window (60s) via fixed circular bucket ring (1 slot per second)
    private readonly bucketBytes = new Float64Array(60)
    private readonly bucketSec = new Int32Array(60)
    private runningWindowBytes = 0

    // Stats
    private totalBytesSent = 0
    private totalSpansBlocked = 0
    private totalBudgetExceeded = 0

    // Cleanup timer
    private cleanupTimer: ReturnType<typeof setInterval> | null = null

    constructor(options: CostGovernorOptions = {}) {
        this.maxSpansPerTrace = options.maxSpansPerTrace ?? 1000
        this.maxActiveInstruments = options.maxActiveInstruments ?? 200
        this.bytesBudgetPerMinute = options.bytesBudgetPerMinute ?? 10 * 1024 * 1024 // 10MB
        this.enableAdaptiveReduction = options.enableAdaptiveReduction ?? true
        this.maxTraceDurationMs = options.maxTraceDurationMs ?? 300_000 // 5 minutes
    }

    /**
     * Update cost governor limits from remote config.
     * Called when remote config is loaded or changes at runtime.
     */
    updateFromConfig(options: Pick<CostGovernorOptions, 'maxSpansPerTrace' | 'maxTraceDurationMs'>): void {
        if (options.maxSpansPerTrace !== undefined) {
            this.maxSpansPerTrace = options.maxSpansPerTrace
        }
        if (options.maxTraceDurationMs !== undefined) {
            this.maxTraceDurationMs = options.maxTraceDurationMs
        }
        getLogger().debug('Cost governor updated from config', {
            maxSpansPerTrace: this.maxSpansPerTrace,
            maxTraceDurationMs: this.maxTraceDurationMs,
        })
    }

    /**
     * Reset internal tracking maps and metrics for testing or between SDK lifetimes.
     */
    reset(): void {
        this.traceSpanCounts.clear()
        this.traceTimestamps.clear()
        this.bucketBytes.fill(0)
        this.bucketSec.fill(0)
        this.runningWindowBytes = 0
        this.totalBytesSent = 0
        this.totalSpansBlocked = 0
        this.totalBudgetExceeded = 0
    }

    /**
     * Check if a new span can be created for the given trace.
     * Returns false if the trace has exceeded its span limit.
     */
    canCreateSpan(traceId: string): boolean {
        const current = this.traceSpanCounts.get(traceId) ?? 0

        if (current >= this.maxSpansPerTrace) {
            this.totalSpansBlocked++
            if (current === this.maxSpansPerTrace) {
                getLogger().warn('Span limit reached for trace', {
                    utilization: 1,
                })
            }
            return false
        }

        this.traceSpanCounts.set(traceId, current + 1)
        if (!this.traceTimestamps.has(traceId)) {
            this.traceTimestamps.set(traceId, epochMs())
        }

        // LRU eviction when tracking too many traces
        if (this.traceSpanCounts.size > this.maxTrackedTraces) {
            this.evictOldestTraces()
        }

        return true
    }

    /**
     * Check if a trace can continue based on its duration.
     * Returns false if the trace has exceeded maxTraceDurationMs.
     */
    canContinueTrace(traceId: string): boolean {
        const startTime = this.traceTimestamps.get(traceId)
        if (startTime === undefined) return true // Unknown trace — allow

        const elapsed = epochMs() - startTime
        if (elapsed > this.maxTraceDurationMs) {
            getLogger().warn('Trace exceeded max duration', {
                traceId: traceId.slice(0, 8) + '...',
                elapsed,
                maxDurationMs: this.maxTraceDurationMs,
            })
            return false
        }

        return true
    }

    /**
     * Record bytes sent for budget tracking.
     */
    recordBytesSent(bytes: number): void {
        const nowSec = Math.floor(epochMs() / 1000)
        this.advanceBuckets(nowSec)
        const idx = nowSec % 60
        this.bucketBytes[idx] = (this.bucketBytes[idx] ?? 0) + bytes
        this.runningWindowBytes += bytes
        this.totalBytesSent += bytes

        if (this.runningWindowBytes > this.bytesBudgetPerMinute) {
            this.totalBudgetExceeded++
            if (this.totalBudgetExceeded % 10 === 1) {
                getLogger().warn('Telemetry bytes budget exceeded', {
                    utilization: this.bytesBudgetPerMinute > 0
                        ? Math.round((this.runningWindowBytes / this.bytesBudgetPerMinute) * 100) / 100
                        : 0,
                })
            }
        }
    }

    /**
     * Get current cost utilization.
     */
    getUtilization(): CostUtilization {
        const bytesPerMinute = this.getCurrentBytesPerMinute()
        const budgetUtilization = this.bytesBudgetPerMinute > 0
            ? bytesPerMinute / this.bytesBudgetPerMinute
            : 0

        return {
            bytesPerMinute,
            budgetUtilization,
            activeTraces: this.traceSpanCounts.size,
            shouldReduce: this.shouldReduceTelemetry(),
        }
    }

    /**
     * Should the SDK reduce telemetry volume?
     * Returns true when approaching budget limits.
     */
    shouldReduceTelemetry(): boolean {
        if (!this.enableAdaptiveReduction) return false

        const utilization = this.getCurrentBytesPerMinute() / this.bytesBudgetPerMinute
        return utilization > 0.8
    }

    getStats(): CostStats {
        const currentBytesPerMinute = this.getCurrentBytesPerMinute()
        return {
            totalBytesSent: this.totalBytesSent,
            totalSpansBlocked: this.totalSpansBlocked,
            totalBudgetExceeded: this.totalBudgetExceeded,
            currentBytesPerMinute,
            budgetUtilization: this.bytesBudgetPerMinute > 0
                ? currentBytesPerMinute / this.bytesBudgetPerMinute
                : 0,
        }
    }


    /**
     * Start the background cleanup timer if not running.
     */
    start(): void {
        if (!this.cleanupTimer) {
            this.cleanupTimer = setInterval(() => this.cleanup(), 30_000)
            this.cleanupTimer.unref()
        }
    }

    shutdown(): void {
        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer)
            this.cleanupTimer = null
        }
    }

    // ─── Internal ───────────────────────────────────────────────────────────

    private advanceBuckets(nowSec: number): void {
        let sum = 0
        const cutoffSec = nowSec - 60
        for (let i = 0; i < 60; i++) {
            if ((this.bucketSec[i] ?? 0) <= cutoffSec) {
                this.bucketBytes[i] = 0
                this.bucketSec[i] = 0
            } else {
                sum += this.bucketBytes[i] ?? 0
            }
        }
        const idx = nowSec % 60
        if (this.bucketSec[idx] !== nowSec) {
            this.bucketSec[idx] = nowSec
            this.bucketBytes[idx] = 0
        }
        this.runningWindowBytes = sum
    }

    private getCurrentBytesPerMinute(): number {
        this.advanceBuckets(Math.floor(epochMs() / 1000))
        return this.runningWindowBytes
    }

    private evictOldestTraces(): void {
        // Map iteration order is insertion order (chronological) — evict oldest entries without array allocations or sorting
        const toRemove = Math.max(1, Math.floor(this.maxTrackedTraces * 0.1))
        let count = 0
        for (const traceId of this.traceTimestamps.keys()) {
            this.traceSpanCounts.delete(traceId)
            this.traceTimestamps.delete(traceId)
            count++
            if (count >= toRemove) break
        }
    }

    private cleanup(): void {
        const now = epochMs()
        const traceMaxAge = 300_000 // 5 minutes

        // Clean old traces
        for (const [traceId, timestamp] of this.traceTimestamps.entries()) {
            if (now - timestamp > traceMaxAge) {
                this.traceSpanCounts.delete(traceId)
                this.traceTimestamps.delete(traceId)
            }
        }

        // Clean old byte windows
        this.advanceBuckets(Math.floor(now / 1000))
    }
}

// ─── Singleton ──────────────────────────────────────────────────────────────

export const costGovernor = new CostGovernor()
