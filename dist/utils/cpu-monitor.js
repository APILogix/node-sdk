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
import os from 'node:os';
import fs from 'node:fs';
const CGROUP_V2_CPU_STAT = '/sys/fs/cgroup/cpu.stat';
const CGROUP_V1_CPU_STAT = '/sys/fs/cgroup/cpu/cpu.stat';
export class CpuMonitor {
    lastCpuUsage = null;
    lastTimestampNs = null;
    lastCgroupStats = null;
    coreCount;
    constructor() {
        this.coreCount = Math.max(1, os.cpus().length);
        this.reset();
    }
    /** Reset baselines to the current instant (used on startup or warmup). */
    reset() {
        this.lastCpuUsage = process.cpuUsage();
        this.lastTimestampNs = process.hrtime.bigint();
        this.lastCgroupStats = this.readCgroupCpuStats();
    }
    /**
     * Samples process CPU usage, host load averages, and container throttling
     * since the last call to `sample()`.
     */
    sample() {
        const currentCpu = process.cpuUsage();
        const currentTimestampNs = process.hrtime.bigint();
        const currentCgroup = this.readCgroupCpuStats();
        let processCpuPercent = 0;
        let userCpuPercent = 0;
        let systemCpuPercent = 0;
        let normalizedCpuPercent = 0;
        if (this.lastCpuUsage && this.lastTimestampNs) {
            const elapsedNs = currentTimestampNs - this.lastTimestampNs;
            const elapsedMicroseconds = Number(elapsedNs) / 1000;
            if (elapsedMicroseconds > 0) {
                const userDiff = currentCpu.user - this.lastCpuUsage.user;
                const systemDiff = currentCpu.system - this.lastCpuUsage.system;
                const totalDiff = userDiff + systemDiff;
                userCpuPercent = Math.round((userDiff / elapsedMicroseconds) * 10000) / 100;
                systemCpuPercent = Math.round((systemDiff / elapsedMicroseconds) * 10000) / 100;
                processCpuPercent = Math.round((totalDiff / elapsedMicroseconds) * 10000) / 100;
                normalizedCpuPercent = Math.round((processCpuPercent / this.coreCount) * 100) / 100;
            }
        }
        this.lastCpuUsage = currentCpu;
        this.lastTimestampNs = currentTimestampNs;
        // Host load averages (Windows returns [0, 0, 0])
        const loadavg = os.loadavg();
        const loadAverage1m = Math.round((loadavg[0] ?? 0) * 100) / 100;
        const loadAverage5m = Math.round((loadavg[1] ?? 0) * 100) / 100;
        const loadAverage15m = Math.round((loadavg[2] ?? 0) * 100) / 100;
        // Container CPU throttling delta
        let throttledPeriodsDelta;
        let throttledTimeMsDelta;
        if (currentCgroup && this.lastCgroupStats) {
            throttledPeriodsDelta = Math.max(0, currentCgroup.nrThrottled - this.lastCgroupStats.nrThrottled);
            const usecDelta = Math.max(0, currentCgroup.throttledUsec - this.lastCgroupStats.throttledUsec);
            throttledTimeMsDelta = Math.round((usecDelta / 1000) * 100) / 100;
        }
        if (currentCgroup) {
            this.lastCgroupStats = currentCgroup;
        }
        return {
            processCpuPercent,
            userCpuPercent,
            systemCpuPercent,
            normalizedCpuPercent,
            loadAverage1m,
            loadAverage5m,
            loadAverage15m,
            throttledPeriodsDelta,
            throttledTimeMsDelta,
        };
    }
    /**
     * Reads Linux Cgroup CPU throttling statistics if available.
     * Returns `null` on Windows, macOS, or unconstrained host Linux.
     */
    readCgroupCpuStats() {
        if (os.platform() !== 'linux')
            return null;
        try {
            let content = null;
            if (fs.existsSync(CGROUP_V2_CPU_STAT)) {
                content = fs.readFileSync(CGROUP_V2_CPU_STAT, 'utf-8');
            }
            else if (fs.existsSync(CGROUP_V1_CPU_STAT)) {
                content = fs.readFileSync(CGROUP_V1_CPU_STAT, 'utf-8');
            }
            if (!content)
                return null;
            let nrPeriods = 0;
            let nrThrottled = 0;
            let throttledUsec = 0;
            for (const line of content.split('\n')) {
                const parts = line.trim().split(/\s+/);
                if (parts.length >= 2) {
                    const key = parts[0];
                    const val = Number(parts[1]);
                    if (!Number.isNaN(val)) {
                        if (key === 'nr_periods')
                            nrPeriods = val;
                        else if (key === 'nr_throttled')
                            nrThrottled = val;
                        else if (key === 'throttled_usec' || key === 'throttled_time') {
                            // cgroup v1 throttled_time is in nanoseconds, v2 throttled_usec is in microseconds
                            throttledUsec = key === 'throttled_time' ? Math.floor(val / 1000) : val;
                        }
                    }
                }
            }
            return { nrPeriods, nrThrottled, throttledUsec };
        }
        catch {
            return null;
        }
    }
}
export const cpuMonitor = new CpuMonitor();
