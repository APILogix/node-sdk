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
import { type PressureLevel } from './backpressure.js';
export type CompositePressureLevel = 'normal' | 'elevated' | 'high' | 'critical';
export interface PressureSnapshot {
    readonly level: CompositePressureLevel;
    readonly memoryLevel: PressureLevel;
    readonly eventLoopLagMs: number;
    readonly queueUtilization: number;
    readonly gcPressure: number;
    readonly score: number;
}
export interface AdaptivePressureOptions {
    /** Polling interval in milliseconds. Default: 2000 */
    readonly pollIntervalMs?: number;
    /** Function to get current queue utilization (0.0–1.0). */
    readonly getQueueUtilization?: () => number;
    /** Optional absolute heap ceiling (MB). Passed to MemoryPressureMonitor. */
    readonly maxMemoryMb?: number;
    /** Whether to monitor runtime memory pressure. Default: true */
    readonly runtimeMetrics?: boolean;
    /** Whether to monitor event loop lag. Default: true */
    readonly eventLoopMonitoring?: boolean;
    /** Whether to monitor GC pauses. Default: true */
    readonly gcMonitoring?: boolean;
}
export declare class AdaptivePressureMonitor {
    private readonly pollIntervalMs;
    private getQueueUtilization;
    private readonly memoryMonitor;
    private readonly options;
    private timer;
    private lastLevel;
    private lastSnapshot;
    private levelChangeCallbacks;
    private readonly lagMonitor;
    private gcObserver;
    private gcTimeMs;
    private gcWindowStart;
    constructor(options?: AdaptivePressureOptions);
    start(): void;
    stop(): void;
    /**
     * Reconfigure which pressure signals are active. Called during SDK init
     * and on config refresh so the control plane can disable individual
     * monitoring families without restarting the process.
     */
    configure(options: AdaptivePressureOptions): void;
    getSnapshot(): PressureSnapshot;
    getLevel(): CompositePressureLevel;
    /**
     * Reconfigure the absolute memory ceiling from remote config. Called
     * during SDK init after the remote config has arrived.
     */
    setMaxMemoryMb(maxMemoryMb: number): void;
    /**
     * Should the system shed events of the given priority?
     * - normal pressure: shed nothing
     * - elevated: shed nothing (warning only)
     * - high: shed 'normal' priority
     * - critical: shed 'normal' and 'high', only 'critical' survives
     */
    shouldShed(priority: 'critical' | 'high' | 'normal'): boolean;
    onLevelChange(callback: (snapshot: PressureSnapshot) => void): void;
    private poll;
    private startGCTracking;
    private stopGCTracking;
}
export declare const adaptivePressure: AdaptivePressureMonitor;
