/**
 * Enterprise GPU Monitor — hardware accelerator telemetry for Node.js.
 *
 * Discovers and queries NVIDIA GPUs using non-blocking asynchronous `nvidia-smi` execution.
 * Caches presence to introduce ZERO overhead in environments without dedicated GPUs.
 */
export interface GpuDeviceMetrics {
    readonly index: number;
    readonly utilizationPercent: number;
    readonly memoryUsedBytes: number;
    readonly memoryTotalBytes: number;
    readonly temperatureCelsius: number;
}
export interface GpuSnapshot {
    readonly gpuCount: number;
    readonly averageUtilizationPercent: number;
    readonly totalMemoryUsedBytes: number;
    readonly totalMemoryBytes: number;
    readonly devices: readonly GpuDeviceMetrics[];
}
export declare class GpuMonitor {
    private static instance;
    private isAvailable;
    private lastSnapshot;
    private isQuerying;
    static getInstance(): GpuMonitor;
    /**
     * Asynchronously queries GPU metrics.
     * If nvidia-smi is not available, immediately resolves with null and disables subsequent queries.
     */
    sample(): Promise<GpuSnapshot | null>;
    getLastSnapshot(): GpuSnapshot | null;
    reset(): void;
}
export declare const gpuMonitor: GpuMonitor;
