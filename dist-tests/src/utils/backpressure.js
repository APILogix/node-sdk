import { EventEmitter } from 'events';
/**
 * Monitors process memory and emits events when pressure levels change.
 *
 * Usage:
 *   const monitor = new MemoryPressureMonitor()
 *   monitor.on('pressure', (state) => { ... })
 *   monitor.start()
 *   // ... later
 *   monitor.stop()
 */
export class MemoryPressureMonitor extends EventEmitter {
    elevatedThreshold;
    criticalThreshold;
    pollIntervalMs;
    minHeapTotalMb;
    maxMemoryMb;
    timer = null;
    lastLevel = 'normal';
    constructor(options = {}) {
        super();
        this.elevatedThreshold = options.elevatedThreshold ?? 0.7;
        this.criticalThreshold = options.criticalThreshold ?? 0.9;
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
        // If heap is small (< minHeapTotalMb), utilization ratio is meaningless
        // V8 starts with a tiny heap that grows on demand — high ratio on small
        // heap does NOT indicate actual pressure.
        let level = 'normal';
        if (heapTotalMb >= this.minHeapTotalMb) {
            if (heapUtilization >= this.criticalThreshold) {
                level = 'critical';
            }
            else if (heapUtilization >= this.elevatedThreshold) {
                level = 'elevated';
            }
        }
        // Also enforce an absolute ceiling if configured. This matters in
        // containers with large heaps where a ratio threshold is too lenient.
        if (this.maxMemoryMb && this.maxMemoryMb > 0) {
            const absoluteUtil = heapUsedMb / this.maxMemoryMb;
            if (absoluteUtil >= this.criticalThreshold) {
                level = 'critical';
            }
            else if (absoluteUtil >= this.elevatedThreshold && level !== 'critical') {
                level = 'elevated';
            }
        }
        return { level, heapUsedMb, heapTotalMb, rssMb, heapUtilization };
    }
    /** Returns true if the system is under elevated or critical memory pressure. */
    isUnderPressure() {
        return this.getState().level !== 'normal';
    }
    /**
     * Check if an event should be accepted based on memory pressure and priority.
     * - normal: accept all
     * - elevated: reject 'normal' priority
     * - critical: reject 'normal' and 'high', only 'critical' survives
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
        const state = this.getState();
        if (state.level !== this.lastLevel) {
            this.lastLevel = state.level;
            this.emit('pressure', state);
        }
    }
}
/**
 * Get current memory pressure level without needing a monitor instance.
 * Quick one-shot check for use in hot paths.
 */
export function getMemoryPressureLevel() {
    const mem = process.memoryUsage();
    const heapTotalMb = mem.heapTotal / (1024 * 1024);
    if (heapTotalMb < 100)
        return 'normal';
    const utilization = mem.heapUsed / mem.heapTotal;
    if (utilization >= 0.9)
        return 'critical';
    if (utilization >= 0.7)
        return 'elevated';
    return 'normal';
}
