/**
 * Enterprise CPU Monitor — high-precision process and system CPU diagnostic engine.
 *
 * Provides:
 * - Process CPU % (user, system, and total) via high-resolution `process.cpuUsage()` and `process.hrtime.bigint()`
 * - Normalized process CPU % (adjusted across available CPU cores)
 * - System-wide load averages (1m, 5m, 15m) via `os.loadavg()`
 * - Linux Cgroups v1 & v2 CPU throttling detection (throttled periods and cumulative throttled microseconds)
 *
 * Safe on all supported operating systems (Windows, Linux, macOS) and container environments.
 */
export interface CpuUsageSnapshot {
    /** Total process CPU utilization % across all cores (0 - 100% * cores). */
    readonly processCpuPercent: number;
    /** User-space CPU utilization % (0 - 100% * cores). */
    readonly userCpuPercent: number;
    /** Kernel-space / system CPU utilization % (0 - 100% * cores). */
    readonly systemCpuPercent: number;
    /** Normalized CPU % (0.0 to 100.0%, divided by CPU core count). */
    readonly normalizedCpuPercent: number;
    /** System load average over 1 minute. */
    readonly loadAverage1m: number;
    /** System load average over 5 minutes. */
    readonly loadAverage5m: number;
    /** System load average over 15 minutes. */
    readonly loadAverage15m: number;
    /** Delta of scheduling periods that were throttled by the container CFS scheduler (Linux only). */
    readonly throttledPeriodsDelta?: number | undefined;
    /** Delta of time in milliseconds that the container was throttled (Linux only). */
    readonly throttledTimeMsDelta?: number | undefined;
}
export declare class CpuMonitor {
    private lastCpuUsage;
    private lastTimestampNs;
    private lastCgroupStats;
    private readonly coreCount;
    constructor();
    /** Reset baselines to the current instant (used on startup or warmup). */
    reset(): void;
    /**
     * Samples process CPU usage, host load averages, and container throttling
     * since the last call to `sample()`.
     */
    sample(): CpuUsageSnapshot;
    /**
     * Reads Linux Cgroup CPU throttling statistics if available.
     * Returns `null` on Windows, macOS, or unconstrained host Linux.
     */
    private readCgroupCpuStats;
}
export declare const cpuMonitor: CpuMonitor;
