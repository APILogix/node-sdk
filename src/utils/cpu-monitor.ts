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

import os from 'node:os'
import fs from 'node:fs'

export interface CpuUsageSnapshot {
  /** Total process CPU utilization % across all cores (0 - 100% * cores). */
  readonly processCpuPercent: number
  /** User-space CPU utilization % (0 - 100% * cores). */
  readonly userCpuPercent: number
  /** Kernel-space / system CPU utilization % (0 - 100% * cores). */
  readonly systemCpuPercent: number
  /** Normalized CPU % (0.0 to 100.0%, divided by CPU core count). */
  readonly normalizedCpuPercent: number
  /** System load average over 1 minute. */
  readonly loadAverage1m: number
  /** System load average over 5 minutes. */
  readonly loadAverage5m: number
  /** System load average over 15 minutes. */
  readonly loadAverage15m: number
  /** Delta of scheduling periods that were throttled by the container CFS scheduler (Linux only). */
  readonly throttledPeriodsDelta?: number | undefined
  /** Delta of time in milliseconds that the container was throttled (Linux only). */
  readonly throttledTimeMsDelta?: number | undefined
}

interface CgroupCpuStats {
  nrPeriods: number
  nrThrottled: number
  throttledUsec: number
}

const CGROUP_V2_CPU_STAT = '/sys/fs/cgroup/cpu.stat'
const CGROUP_V1_CPU_STAT = '/sys/fs/cgroup/cpu/cpu.stat'

export class CpuMonitor {
  private lastCpuUsage: NodeJS.CpuUsage | null = null
  private lastTimestampNs: bigint | null = null
  private lastCgroupStats: CgroupCpuStats | null = null
  private readonly coreCount: number

  constructor() {
    this.coreCount = Math.max(1, os.cpus().length)
    this.reset()
  }

  /** Reset baselines to the current instant (used on startup or warmup). */
  reset(): void {
    this.lastCpuUsage = process.cpuUsage()
    this.lastTimestampNs = process.hrtime.bigint()
    this.lastCgroupStats = this.readCgroupCpuStats()
  }

  /**
   * Samples process CPU usage, host load averages, and container throttling
   * since the last call to `sample()`.
   */
  sample(): CpuUsageSnapshot {
    const currentCpu = process.cpuUsage()
    const currentTimestampNs = process.hrtime.bigint()
    const currentCgroup = this.readCgroupCpuStats()

    let processCpuPercent = 0
    let userCpuPercent = 0
    let systemCpuPercent = 0
    let normalizedCpuPercent = 0

    if (this.lastCpuUsage && this.lastTimestampNs) {
      const elapsedNs = currentTimestampNs - this.lastTimestampNs
      const elapsedMicroseconds = Number(elapsedNs) / 1000

      if (elapsedMicroseconds > 0) {
        const userDiff = currentCpu.user - this.lastCpuUsage.user
        const systemDiff = currentCpu.system - this.lastCpuUsage.system
        const totalDiff = userDiff + systemDiff

        userCpuPercent = Math.round((userDiff / elapsedMicroseconds) * 10000) / 100
        systemCpuPercent = Math.round((systemDiff / elapsedMicroseconds) * 10000) / 100
        processCpuPercent = Math.round((totalDiff / elapsedMicroseconds) * 10000) / 100
        normalizedCpuPercent = Math.round((processCpuPercent / this.coreCount) * 100) / 100
      }
    }

    this.lastCpuUsage = currentCpu
    this.lastTimestampNs = currentTimestampNs

    // Host load averages (Windows returns [0, 0, 0])
    const loadavg = os.loadavg()
    const loadAverage1m = Math.round((loadavg[0] ?? 0) * 100) / 100
    const loadAverage5m = Math.round((loadavg[1] ?? 0) * 100) / 100
    const loadAverage15m = Math.round((loadavg[2] ?? 0) * 100) / 100

    // Container CPU throttling delta
    let throttledPeriodsDelta: number | undefined
    let throttledTimeMsDelta: number | undefined

    if (currentCgroup && this.lastCgroupStats) {
      throttledPeriodsDelta = Math.max(0, currentCgroup.nrThrottled - this.lastCgroupStats.nrThrottled)
      const usecDelta = Math.max(0, currentCgroup.throttledUsec - this.lastCgroupStats.throttledUsec)
      throttledTimeMsDelta = Math.round((usecDelta / 1000) * 100) / 100
    }

    if (currentCgroup) {
      this.lastCgroupStats = currentCgroup
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
    }
  }

  /**
   * Reads Linux Cgroup CPU throttling statistics if available.
   * Returns `null` on Windows, macOS, or unconstrained host Linux.
   */
  private readCgroupCpuStats(): CgroupCpuStats | null {
    if (os.platform() !== 'linux') return null

    try {
      let content: string | null = null
      if (fs.existsSync(CGROUP_V2_CPU_STAT)) {
        content = fs.readFileSync(CGROUP_V2_CPU_STAT, 'utf-8')
      } else if (fs.existsSync(CGROUP_V1_CPU_STAT)) {
        content = fs.readFileSync(CGROUP_V1_CPU_STAT, 'utf-8')
      }

      if (!content) return null

      let nrPeriods = 0
      let nrThrottled = 0
      let throttledUsec = 0

      for (const line of content.split('\n')) {
        const parts = line.trim().split(/\s+/)
        if (parts.length >= 2) {
          const key = parts[0]
          const val = Number(parts[1])
          if (!Number.isNaN(val)) {
            if (key === 'nr_periods') nrPeriods = val
            else if (key === 'nr_throttled') nrThrottled = val
            else if (key === 'throttled_usec' || key === 'throttled_time') {
              // cgroup v1 throttled_time is in nanoseconds, v2 throttled_usec is in microseconds
              throttledUsec = key === 'throttled_time' ? Math.floor(val / 1000) : val
            }
          }
        }
      }

      return { nrPeriods, nrThrottled, throttledUsec }
    } catch {
      return null
    }
  }
}

export const cpuMonitor = new CpuMonitor()
