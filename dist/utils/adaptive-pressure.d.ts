/**
 * Adaptive Pressure Monitor — Unified Runtime Protection & 5-State Pressure Engine.
 *
 * Combines multiple pressure signals with hysteresis to prevent oscillation:
 * - Memory pressure (effective heap utilization ratio)
 * - Event loop lag (perf_hooks monitorEventLoopDelay p99)
 * - Queue depth (% of max capacity)
 * - GC pressure (PerformanceObserver GC duration tracking)
 *
 * 5-State State Machine:
 * - HEALTHY: Full admission of all telemetry.
 * - ELEVATED: Warning state; minor reduction of low-value P3 debug telemetry.
 * - PRESSURED: Aggressive P3 shedding, reduce optional metadata. Preserve P0/P1/P2 groups.
 * - CRITICAL: Protect the host application first. Preserve P0 and P1 diagnostic groups.
 * - RECOVERING: Smooth stepped recovery preventing backlog/replay storms.
 */
import { type PressureLevel } from './backpressure.js';
import type { PressureState } from '../types/telemetry-classes.js';
export type CompositePressureLevel = 'normal' | 'elevated' | 'high' | 'critical' | 'healthy' | 'pressured' | 'recovering';
export interface PressureSnapshot {
    readonly level: CompositePressureLevel;
    readonly state: PressureState;
    readonly memoryLevel: PressureLevel;
    readonly effectiveMemoryUtilization: number;
    readonly eventLoopLagMs: number;
    readonly queueUtilization: number;
    readonly gcPressure: number;
    readonly score: number;
    readonly transitions: number;
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
    private currentState;
    private recoveryCycles;
    private transitionCount;
    private recoveryTransitionCount;
    private lastSnapshot;
    private levelChangeCallbacks;
    private readonly lagMonitor;
    private gcObserver;
    private gcTimeMs;
    private gcWindowStart;
    constructor(options?: AdaptivePressureOptions);
    start(): void;
    stop(): void;
    /** Reset all monitoring state (useful after init warmup). */
    resetWarmup(): void;
    configure(options: AdaptivePressureOptions): void;
    getSnapshot(): PressureSnapshot;
    getState(): PressureState;
    /** Backward-compatible level getter returning 'normal' | 'elevated' | 'high' | 'critical'. */
    getLevel(): CompositePressureLevel;
    setMaxMemoryMb(maxMemoryMb: number): void;
    /**
     * Determine if an event should be shed based on current pressure state.
     */
    shouldShed(priority: 'critical' | 'high' | 'normal'): boolean;
    onLevelChange(callback: (snapshot: PressureSnapshot) => void): void;
    poll(): void;
    private evaluateStateWithHysteresis;
    private startGCTracking;
    private stopGCTracking;
}
export declare const adaptivePressure: AdaptivePressureMonitor;
