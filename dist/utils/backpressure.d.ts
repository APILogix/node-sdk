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
    readonly effectiveLimitMb: number;
    readonly effectiveUtilization: number;
}
export interface MemoryPressureOptions {
    /** Effective utilization threshold for 'elevated' (0.0–1.0). Default: 0.70 */
    readonly elevatedThreshold?: number;
    /** Effective utilization threshold for 'critical' (0.0–1.0). Default: 0.88 */
    readonly criticalThreshold?: number;
    /** Elevated exit threshold for hysteresis (0.0–1.0). Default: 0.60 */
    readonly elevatedExitThreshold?: number;
    /** Critical exit threshold for hysteresis (0.0–1.0). Default: 0.75 */
    readonly criticalExitThreshold?: number;
    /** Polling interval in milliseconds. Default: 5000 */
    readonly pollIntervalMs?: number;
    /** Minimum heap total (MB) before utilization thresholds apply. Default: 100 */
    readonly minHeapTotalMb?: number;
    /** Optional absolute ceiling (MB). When set, pressure is computed against this limit. */
    readonly maxMemoryMb?: number | undefined;
}
/**
 * Monitors process memory and emits events when pressure levels change.
 * Uses effective heap limit and hysteresis to prevent false alarms during V8 heap expansion.
 */
export declare class MemoryPressureMonitor extends EventEmitter {
    private readonly elevatedThreshold;
    private readonly criticalThreshold;
    private readonly elevatedExitThreshold;
    private readonly criticalExitThreshold;
    private readonly pollIntervalMs;
    private readonly minHeapTotalMb;
    private maxMemoryMb;
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
     */
    shouldAcceptEvent(priority: EventPriority): boolean;
    /** Convenience method to register a pressure change callback. */
    onPressureChange(callback: (state: MemoryPressureState) => void): void;
    /** Update the absolute memory ceiling after construction. */
    setMaxMemoryMb(maxMemoryMb: number): void;
    private check;
}
export type EventPriority = 'critical' | 'high' | 'normal';
/**
 * Get current memory pressure level without needing a monitor instance.
 * Quick one-shot check for use in hot paths.
 */
export declare function getMemoryPressureLevel(): PressureLevel;
