/**
 * RuntimeMetricsSubsystem — continuously monitors Node.js & V8 runtime diagnostics.
 *
 * Emits reserved runtime metrics conforming to the LynkTrace Ingestion & Analytics contract:
 *   - runtime.heap.used
 *   - runtime.heap.total
 *   - runtime.memory.external
 *   - runtime.memory.rss
 *   - runtime.handles.active
 *   - runtime.eventloop.lag
 *   - runtime.eventloop.utilization
 *   - runtime.gc.pause
 *
 * Behavior:
 * - Active when remote config `features.runtimeMetrics = true`.
 * - Polled on an unref timer (default: 15s) with sub-millisecond CPU cost.
 * - Records metrics into `metricsRegistry` / `captureMetric` with type 'gauge' or 'histogram'.
 * - Safe on all supported Node.js versions (>=18.19.0).
 * - Full lifecycle integration: starts in `init()`, resets on `shutdown()`.
 */
import type { RemoteConfigResponse, ConfigDiff } from '../types/config.js';
export declare const RUNTIME_METRIC_NAMES: {
    readonly heapUsed: 'runtime.heap.used';
    readonly heapTotal: 'runtime.heap.total';
    readonly external: 'runtime.memory.external';
    readonly rss: 'runtime.memory.rss';
    readonly handles: 'runtime.handles.active';
    readonly eventLoopLag: 'runtime.eventloop.lag';
    readonly eventLoopUtilization: 'runtime.eventloop.utilization';
    readonly gcPause: 'runtime.gc.pause';
};
export interface RuntimeMetricsOptions {
    intervalMs?: number;
    enabled?: boolean;
    eventLoopMonitoring?: boolean;
    gcMonitoring?: boolean;
}
export declare class RuntimeMetricsSubsystem {
    private static instance;
    private intervalMs;
    private enabled;
    private eventLoopMonitoring;
    private gcMonitoring;
    private timer;
    private lagHistogram;
    private gcObserver;
    private previousElu;
    static getInstance(): RuntimeMetricsSubsystem;
    static resetInstance(): void;
    configure(config: Readonly<RemoteConfigResponse>): void;
    handleConfigChange(diff: ConfigDiff, newConfig: Readonly<RemoteConfigResponse>): void;
    start(options?: RuntimeMetricsOptions): void;
    stop(): void;
    collect(): void;
}
