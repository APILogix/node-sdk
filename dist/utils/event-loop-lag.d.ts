/**
 * Event Loop Lag Monitor — tracks Node.js event loop latency using
 * the built-in `perf_hooks.monitorEventLoopDelay` API.
 *
 * This is critical for observability: high event loop lag indicates
 * CPU saturation, blocking I/O, or GC pauses that degrade application
 * performance.
 *
 * Usage:
 *   const monitor = new EventLoopLagMonitor({ emitIntervalMs: 10_000 })
 *   monitor.start()
 *   monitor.on('lag', (stats) => captureMetric('event_loop.lag_ms', stats.p99))
 *   // ...
 *   monitor.stop()
 */
import { EventEmitter } from 'events';
export interface EventLoopLagStats {
    /** Minimum lag in milliseconds */
    readonly min: number;
    /** Maximum lag in milliseconds */
    readonly max: number;
    /** Mean lag in milliseconds */
    readonly mean: number;
    /** 50th percentile (median) lag in milliseconds */
    readonly p50: number;
    /** 90th percentile lag in milliseconds */
    readonly p90: number;
    /** 95th percentile lag in milliseconds */
    readonly p95: number;
    /** 99th percentile lag in milliseconds */
    readonly p99: number;
    /** Standard deviation in milliseconds */
    readonly stddev: number;
}
export interface EventLoopLagOptions {
    /** How often to emit 'lag' events (milliseconds). Default: 10000 */
    readonly emitIntervalMs?: number;
    /** Resolution for the histogram in milliseconds. Default: 20 */
    readonly resolutionMs?: number;
    /** Legacy resolution option. Automatically normalized to milliseconds. */
    readonly resolutionNs?: number;
}
/**
 * Monitors the Node.js event loop delay using a high-resolution histogram.
 *
 * Emits:
 *   'lag' → { min, max, mean, p50, p90, p95, p99, stddev } (all in ms)
 */
export declare class EventLoopLagMonitor extends EventEmitter {
    private readonly emitIntervalMs;
    private readonly resolutionMs;
    private histogram;
    private timer;
    constructor(options?: EventLoopLagOptions);
    /** Start monitoring the event loop. */
    start(): void;
    /** Stop monitoring and clean up. */
    stop(): void;
    /** Reset the histogram to clear startup/warmup outliers. */
    reset(): void;
    /** Get current lag stats without emitting an event. */
    getStats(): EventLoopLagStats | null;
    /** Returns true if event loop lag p99 exceeds the given threshold (ms). */
    isLagging(thresholdMs: number): boolean;
    private emitStats;
    private extractHistogramStats;
    private lastStats;
    private readHistogram;
}
