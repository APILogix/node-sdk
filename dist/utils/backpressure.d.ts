import { EventEmitter } from 'events';
/**
 * Memory pressure levels — drive graceful degradation decisions.
 */
export type PressureLevel = 'normal' | 'elevated' | 'critical';
export interface MemoryPressureState {
    readonly level: PressureLevel;
    readonly heapUsedMb: number;
    readonly heapTotalMb: number;
    readonly rssMb: number;
    readonly heapUtilization: number;
}
export interface MemoryPressureOptions {
    /** Heap utilization threshold for 'elevated' (0.0–1.0). Default: 0.7 */
    readonly elevatedThreshold?: number;
    /** Heap utilization threshold for 'critical' (0.0–1.0). Default: 0.9 */
    readonly criticalThreshold?: number;
    /** Polling interval in milliseconds. Default: 5000 */
    readonly pollIntervalMs?: number;
    /** Minimum heap total (MB) before utilization thresholds apply. Default: 100 */
    readonly minHeapTotalMb?: number;
}
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
export declare class MemoryPressureMonitor extends EventEmitter {
    private readonly elevatedThreshold;
    private readonly criticalThreshold;
    private readonly pollIntervalMs;
    private readonly minHeapTotalMb;
    private timer;
    private lastLevel;
    constructor(options?: MemoryPressureOptions);
    /** Start monitoring memory pressure. */
    start(): void;
    /** Stop monitoring. */
    stop(): void;
    /** Get current memory pressure state without emitting events. */
    getState(): MemoryPressureState;
    /** Returns true if the system is under elevated or critical memory pressure. */
    isUnderPressure(): boolean;
    /**
     * Check if an event should be accepted based on memory pressure and priority.
     * - normal: accept all
     * - elevated: reject 'normal' priority
     * - critical: reject 'normal' and 'high', only 'critical' survives
     */
    shouldAcceptEvent(priority: EventPriority): boolean;
    /** Convenience method to register a pressure change callback. */
    onPressureChange(callback: (state: MemoryPressureState) => void): void;
    private check;
}
export type EventPriority = 'critical' | 'high' | 'normal';
/**
 * Get current memory pressure level without needing a monitor instance.
 * Quick one-shot check for use in hot paths.
 */
export declare function getMemoryPressureLevel(): PressureLevel;
//# sourceMappingURL=backpressure.d.ts.map