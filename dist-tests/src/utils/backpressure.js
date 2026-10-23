import { EventEmitter } from 'events';
import * as v8 from 'node:v8';
/**
 * Monitors process memory and emits events when pressure levels change.
 * Uses effective heap limit and hysteresis to prevent false alarms during V8 heap expansion.
 */
export class MemoryPressureMonitor extends EventEmitter {
    elevatedThreshold;
    criticalThreshold;
    elevatedExitThreshold;
    criticalExitThreshold;
    pollIntervalMs;
    minHeapTotalMb;
    maxMemoryMb;
    timer = null;
    lastLevel = 'normal';
    constructor(options = {}) {
        super();
        this.elevatedThreshold = options.elevatedThreshold ?? 0.70;
        this.criticalThreshold = options.criticalThreshold ?? 0.88;
        this.elevatedExitThreshold = options.elevatedExitThreshold ?? 0.60;
        this.criticalExitThreshold = options.criticalExitThreshold ?? 0.75;
        this.pollIntervalMs = options.pollIntervalMs ?? 5000;
        this.minHeapTotalMb = options.minHeapTotalMb ?? 100;
        this.maxMemoryMb = options.maxMemoryMb;
    }
    /** Start monitoring memory pressure. */
    start() {
        if (this.timer)
            return;
        this.timer = setInterval(() => {
            this.check();
        }, this.pollIntervalMs);
        // Don't hold the process open just for memory monitoring
        this.timer.unref();
    }
    /** Stop monitoring. */
    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }
    /** Get current memory pressure state without emitting events. */
    getState() {
        const mem = process.memoryUsage();
        const heapUsedMb = mem.heapUsed / (1024 * 1024);
        const heapTotalMb = mem.heapTotal / (1024 * 1024);
        const rssMb = mem.rss / (1024 * 1024);
        const heapUtilization = mem.heapTotal > 0 ? mem.heapUsed / mem.heapTotal : 0;
        // Resolve the true effective memory ceiling (either configured maxMemoryMb or V8 heap limit)
        let effectiveLimitMb = this.maxMemoryMb && this.maxMemoryMb > 0
            ? this.maxMemoryMb
            : 0;
        let v8LimitMb = 0;
        try {
            const v8Limit = v8.getHeapStatistics().heap_size_limit;
            if (v8Limit > 0)
                v8LimitMb = v8Limit / (1024 * 1024);
        }
        catch { }
        if (effectiveLimitMb <= 0) {
            effectiveLimitMb = v8LimitMb > 0 ? v8LimitMb : 1024;
        }
        // In enterprise runtimes with large heaps (e.g. --max-old-space-size),
        // compute utilization against the active headroom ceiling to prevent false OOM shedding.
        const activeCeilingMb = Math.max(effectiveLimitMb, v8LimitMb);
        const effectiveUtilization = activeCeilingMb > 0 ? heapUsedMb / activeCeilingMb : 0;
        // Compute pressure level with hysteresis
        let level = this.lastLevel;
        if (this.lastLevel === 'critical') {
            // Exit critical only if effective utilization drops below criticalExitThreshold
            if (effectiveUtilization < this.criticalExitThreshold) {
                level = effectiveUtilization >= this.elevatedThreshold ? 'elevated' : 'normal';
            }
        }
        else if (this.lastLevel === 'elevated') {
            if (effectiveUtilization >= this.criticalThreshold) {
                level = 'critical';
            }
            else if (effectiveUtilization < this.elevatedExitThreshold) {
                level = 'normal';
            }
        }
        else {
            // Currently normal
            if (effectiveUtilization >= this.criticalThreshold) {
                level = 'critical';
            }
            else if (effectiveUtilization >= this.elevatedThreshold) {
                level = 'elevated';
            }
        }
        // Secondary check: if heap is already large (> 75% of limit) AND heapTotal is nearly 100% full
        if (heapTotalMb >= this.minHeapTotalMb && heapTotalMb >= effectiveLimitMb * 0.75) {
            if (heapUtilization >= 0.95 && level === 'normal') {
                level = 'elevated';
            }
        }
        const previousLevel = this.lastLevel;
        this.lastLevel = level;
        const state = {
            level,
            heapUsedMb,
            heapTotalMb,
            rssMb,
            heapUtilization,
            effectiveLimitMb,
            effectiveUtilization,
        };
        if (level !== previousLevel && this.listenerCount('pressure') > 0) {
            this.emit('pressure', state);
        }
        return state;
    }
    /** Returns true if the system is under elevated or critical memory pressure. */
    isUnderPressure() {
        return this.getState().level !== 'normal';
    }
    /**
     * Check if an event should be accepted based on memory pressure and priority.
     */
    shouldAcceptEvent(priority) {
        const level = this.getState().level;
        switch (level) {
            case 'normal':
                return true;
            case 'elevated':
                return priority !== 'normal';
            case 'critical':
                return priority === 'critical';
        }
    }
    /** Convenience method to register a pressure change callback. */
    onPressureChange(callback) {
        this.on('pressure', callback);
    }
    /** Update the absolute memory ceiling after construction. */
    setMaxMemoryMb(maxMemoryMb) {
        this.maxMemoryMb = maxMemoryMb;
    }
    check() {
        this.getState();
    }
}
/**
 * Get current memory pressure level without needing a monitor instance.
 * Quick one-shot check for use in hot paths.
 */
export function getMemoryPressureLevel() {
    const mem = process.memoryUsage();
    const heapUsedMb = mem.heapUsed / (1024 * 1024);
    let effectiveLimitMb = 1024;
    try {
        const v8Limit = v8.getHeapStatistics().heap_size_limit;
        if (v8Limit > 0)
            effectiveLimitMb = v8Limit / (1024 * 1024);
    }
    catch { }
    const utilization = heapUsedMb / effectiveLimitMb;
    if (utilization >= 0.88)
        return 'critical';
    if (utilization >= 0.70)
        return 'elevated';
    return 'normal';
}
