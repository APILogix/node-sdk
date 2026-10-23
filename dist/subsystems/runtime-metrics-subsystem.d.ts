/**
 * RuntimeMetricsSubsystem — continuously monitors Node.js, V8 runtime diagnostics,
 * CPU consumption, memory, disk storage, and hardware accelerators.
 *
 * Emits reserved runtime metrics conforming to the LynkTrace & Pulse Ingestion contracts:
 *   - runtime.heap.used
 *   - runtime.heap.total
 *   - runtime.memory.external
 *   - runtime.memory.rss
 *   - runtime.memory.array_buffers
 *   - runtime.handles.active
 *   - runtime.eventloop.lag (p99 + p50/p90/p95/max/mean)
 *   - runtime.eventloop.utilization
 *   - runtime.gc.pause
 *   - runtime.gc.count
 *   - runtime.gc.reclaimed.bytes
 *   - runtime.cpu.utilization
 *   - runtime.cpu.user
 *   - runtime.cpu.system
 *   - runtime.cpu.loadavg.1m, 5m, 15m
 *   - container.cpu.throttling.periods
 *   - container.cpu.throttling.time_ms
 *   - system.memory.free
 *   - system.memory.total
 *   - system.disk.total_bytes
 *   - system.disk.free_bytes
 *   - system.disk.used_percent
 *   - gpu.utilization, gpu.memory.used, gpu.memory.total, gpu.temperature (optional)
 *
 * Behavior:
 * - Active when remote config `features.runtimeMetrics = true`.
 * - Polled on an unref timer (default: 15s) with sub-millisecond CPU cost.
 * - Records metrics into `metricsRegistry` / `captureMetric` with type 'gauge', 'counter', or 'histogram'.
 * - Safe on all supported Node.js versions (>=18.19.0).
 * - Full lifecycle integration: starts in `init()`, resets on `shutdown()`.
 */
import type { RemoteConfigResponse, ConfigDiff } from '../types/config.js';
export declare const RUNTIME_METRIC_NAMES: {
    readonly heapUsed: 'runtime.heap.used';
    readonly heapTotal: 'runtime.heap.total';
    readonly external: 'runtime.memory.external';
    readonly rss: 'runtime.memory.rss';
    readonly arrayBuffers: 'runtime.memory.array_buffers';
    readonly handles: 'runtime.handles.active';
    readonly eventLoopLag: 'runtime.eventloop.lag';
    readonly eventLoopUtilization: 'runtime.eventloop.utilization';
    readonly eventLoopLagP50: 'runtime.eventloop.lag.p50';
    readonly eventLoopLagP90: 'runtime.eventloop.lag.p90';
    readonly eventLoopLagP95: 'runtime.eventloop.lag.p95';
    readonly eventLoopLagMax: 'runtime.eventloop.lag.max';
    readonly eventLoopLagMean: 'runtime.eventloop.lag.mean';
    readonly gcPause: 'runtime.gc.pause';
    readonly gcCount: 'runtime.gc.count';
    readonly gcReclaimed: 'runtime.gc.reclaimed.bytes';
    readonly cpuUtilization: 'runtime.cpu.utilization';
    readonly cpuUser: 'runtime.cpu.user';
    readonly cpuSystem: 'runtime.cpu.system';
    readonly loadAvg1m: 'runtime.cpu.loadavg.1m';
    readonly loadAvg5m: 'runtime.cpu.loadavg.5m';
    readonly loadAvg15m: 'runtime.cpu.loadavg.15m';
    readonly cgroupThrottledPeriods: 'container.cpu.throttling.periods';
    readonly cgroupThrottledTimeMs: 'container.cpu.throttling.time_ms';
    readonly systemMemoryFree: 'system.memory.free';
    readonly systemMemoryTotal: 'system.memory.total';
    readonly diskTotal: 'system.disk.total_bytes';
    readonly diskFree: 'system.disk.free_bytes';
    readonly diskUsedPercent: 'system.disk.used_percent';
    readonly gpuUtilization: 'gpu.utilization';
    readonly gpuMemoryUsed: 'gpu.memory.used';
    readonly gpuMemoryTotal: 'gpu.memory.total';
    readonly gpuTemperature: 'gpu.temperature';
};
export interface RuntimeMetricsOptions {
    intervalMs?: number;
    enabled?: boolean;
    eventLoopMonitoring?: boolean;
    gcMonitoring?: boolean;
    cpuMonitoring?: boolean;
    storageMonitoring?: boolean;
    gpuMonitoring?: boolean;
}
/**
 * Decodes numeric V8 GC bitflag constants into human-readable semantic strings.
 */
export declare function decodeGcKind(kind: number | string): string;
export declare class RuntimeMetricsSubsystem {
    private static instance;
    private intervalMs;
    private eventLoopResolutionMs;
    private enabled;
    private eventLoopMonitoring;
    private gcMonitoring;
    private cpuMonitoring;
    private storageMonitoring;
    private gpuMonitoring;
    private timer;
    private lagHistogram;
    private gcObserver;
    private previousElu;
    private lastHeapUsedForGc;
    static getInstance(): RuntimeMetricsSubsystem;
    static resetInstance(): void;
    configure(config: Readonly<RemoteConfigResponse>): void;
    private restartTimer;
    handleConfigChange(diff: ConfigDiff, newConfig: Readonly<RemoteConfigResponse>): void;
    start(options?: RuntimeMetricsOptions): void;
    stop(): void;
    collect(): void;
}
