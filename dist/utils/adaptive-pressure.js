/**
 * Adaptive Pressure Monitor — unified runtime protection system.
 *
 * Combines multiple pressure signals into a single composite score:
 * - Memory pressure (heap utilization ratio)
 * - Event loop lag (perf_hooks monitorEventLoopDelay p99)
 * - Queue depth (% of max capacity)
 * - GC pressure (PerformanceObserver GC duration tracking)
 *
 * Produces a single CompositePressureLevel that all subsystems query
 * for adaptive behavior: sampling, shedding, throttling, batching.
 */
import { MemoryPressureMonitor } from './backpressure.js';
import { EventLoopLagMonitor } from './event-loop-lag.js';
import { getLogger } from './logger.js';
// ─── Scoring Constants ──────────────────────────────────────────────────────
const SCORE_NORMAL_MAX = 25;
const SCORE_ELEVATED_MAX = 50;
const SCORE_HIGH_MAX = 75;
// ─── Implementation ─────────────────────────────────────────────────────────
export class AdaptivePressureMonitor {
    pollIntervalMs;
    getQueueUtilization;
    memoryMonitor;
    timer = null;
    lastLevel = 'normal';
    lastSnapshot;
    levelChangeCallbacks = [];
    // High-precision event loop lag via perf_hooks histogram
    lagMonitor;
    // GC tracking
    gcObserver = null;
    gcTimeMs = 0;
    gcWindowStart = 0;
    constructor(options = {}) {
        this.pollIntervalMs = options.pollIntervalMs ?? 2000;
        this.getQueueUtilization = options.getQueueUtilization ?? (() => 0);
        this.memoryMonitor = new MemoryPressureMonitor({
            elevatedThreshold: 0.7,
            criticalThreshold: 0.9,
            pollIntervalMs: this.pollIntervalMs,
        });
        this.lagMonitor = new EventLoopLagMonitor({ emitIntervalMs: this.pollIntervalMs });
        this.lastSnapshot = {
            level: 'normal',
            memoryLevel: 'normal',
            eventLoopLagMs: 0,
            queueUtilization: 0,
            gcPressure: 0,
            score: 0,
        };
    }
    start() {
        if (this.timer)
            return;
        this.memoryMonitor.start();
        this.lagMonitor.start();
        this.startGCTracking();
        this.gcWindowStart = Date.now();
        this.timer = setInterval(() => {
            this.poll();
        }, this.pollIntervalMs);
        this.timer.unref();
    }
    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        this.memoryMonitor.stop();
        this.lagMonitor.stop();
        this.stopGCTracking();
        this.levelChangeCallbacks = [];
    }
    getSnapshot() {
        return this.lastSnapshot;
    }
    getLevel() {
        return this.lastLevel;
    }
    /**
     * Should the system shed events of the given priority?
     * - normal pressure: shed nothing
     * - elevated: shed nothing (warning only)
     * - high: shed 'normal' priority
     * - critical: shed 'normal' and 'high', only 'critical' survives
     */
    shouldShed(priority) {
        switch (this.lastLevel) {
            case 'normal':
            case 'elevated':
                return false;
            case 'high':
                return priority === 'normal';
            case 'critical':
                return priority !== 'critical';
        }
    }
    onLevelChange(callback) {
        this.levelChangeCallbacks.push(callback);
    }
    // ─── Internal ───────────────────────────────────────────────────────────
    poll() {
        const now = Date.now();
        // Read high-precision event loop lag from perf_hooks histogram
        const lagStats = this.lagMonitor.getStats();
        const currentLagMs = lagStats?.p99 ?? 0;
        // Compute GC pressure as % of wall time
        const gcWindowDuration = now - this.gcWindowStart;
        const gcPressure = gcWindowDuration > 0 ? (this.gcTimeMs / gcWindowDuration) * 100 : 0;
        // Reset GC window periodically (every 60s)
        if (gcWindowDuration > 60_000) {
            this.gcTimeMs = 0;
            this.gcWindowStart = now;
        }
        const memoryState = this.memoryMonitor.getState();
        const queueUtil = this.getQueueUtilization();
        // Score each dimension
        const memoryScore = scoreMemory(memoryState.level);
        const lagScore = scoreLag(currentLagMs);
        const queueScore = scoreQueue(queueUtil);
        const gcScore = scoreGC(gcPressure);
        // Composite: max-of to ensure any single critical signal dominates
        const compositeScore = Math.max(memoryScore, lagScore, queueScore, gcScore);
        const level = scoreToLevel(compositeScore);
        this.lastSnapshot = {
            level,
            memoryLevel: memoryState.level,
            eventLoopLagMs: currentLagMs,
            queueUtilization: queueUtil,
            gcPressure,
            score: compositeScore,
        };
        if (level !== this.lastLevel) {
            const previousLevel = this.lastLevel;
            this.lastLevel = level;
            getLogger().info('Pressure level changed', {
                from: previousLevel,
                to: level,
                score: compositeScore,
                memory: memoryState.level,
                lagMs: currentLagMs,
                queueUtil: (queueUtil * 100).toFixed(1) + '%',
                gcPressure: gcPressure.toFixed(1) + '%',
            });
            for (const callback of this.levelChangeCallbacks) {
                try {
                    callback(this.lastSnapshot);
                }
                catch {
                    // Never crash from callback errors
                }
            }
        }
    }
    startGCTracking() {
        try {
            this.gcObserver = new PerformanceObserver(list => {
                for (const entry of list.getEntries()) {
                    this.gcTimeMs += entry.duration;
                }
            });
            this.gcObserver.observe({ entryTypes: ['gc'] });
        }
        catch {
            // GC observation not available in all environments
        }
    }
    stopGCTracking() {
        if (this.gcObserver) {
            this.gcObserver.disconnect();
            this.gcObserver = null;
        }
    }
}
// ─── Scoring Functions ──────────────────────────────────────────────────────
function scoreMemory(level) {
    switch (level) {
        case 'normal': return 0;
        case 'elevated': return 40;
        case 'critical': return 80;
    }
}
function scoreLag(lagMs) {
    if (lagMs < 50)
        return 0;
    if (lagMs < 200)
        return 20;
    if (lagMs < 500)
        return 45;
    return 75;
}
function scoreQueue(utilization) {
    if (utilization < 0.5)
        return 0;
    if (utilization < 0.8)
        return 25;
    if (utilization < 0.95)
        return 50;
    return 75;
}
function scoreGC(gcPercent) {
    if (gcPercent < 10)
        return 0;
    if (gcPercent < 30)
        return 25;
    return 50;
}
function scoreToLevel(score) {
    if (score < SCORE_NORMAL_MAX)
        return 'normal';
    if (score < SCORE_ELEVATED_MAX)
        return 'elevated';
    if (score < SCORE_HIGH_MAX)
        return 'high';
    return 'critical';
}
// ─── Singleton ──────────────────────────────────────────────────────────────
export const adaptivePressure = new AdaptivePressureMonitor();
//# sourceMappingURL=adaptive-pressure.js.map