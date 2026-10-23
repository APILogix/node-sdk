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

import { monitorEventLoopDelay, performance, PerformanceObserver, constants as perfConstants, type IntervalHistogram } from 'node:perf_hooks'
import os from 'node:os'
import { getLogger } from '../utils/logger.js'
import { setGauge, recordHistogram, incrementCounter } from '../capture/captureMetric.js'
import type { RemoteConfigResponse, ConfigDiff } from '../types/config.js'
import { KillswitchEngine } from '../core/killswitch-engine.js'
import { cpuMonitor } from '../utils/cpu-monitor.js'
import { StorageDetector } from '../utils/storage-detector.js'
import { gpuMonitor } from '../utils/gpu-monitor.js'

export const RUNTIME_METRIC_NAMES = {
  // Core V8 Memory
  heapUsed: 'runtime.heap.used',
  heapTotal: 'runtime.heap.total',
  external: 'runtime.memory.external',
  rss: 'runtime.memory.rss',
  arrayBuffers: 'runtime.memory.array_buffers',

  // Active Handles & Event Loop
  handles: 'runtime.handles.active',
  eventLoopLag: 'runtime.eventloop.lag',
  eventLoopUtilization: 'runtime.eventloop.utilization',
  eventLoopLagP50: 'runtime.eventloop.lag.p50',
  eventLoopLagP90: 'runtime.eventloop.lag.p90',
  eventLoopLagP95: 'runtime.eventloop.lag.p95',
  eventLoopLagMax: 'runtime.eventloop.lag.max',
  eventLoopLagMean: 'runtime.eventloop.lag.mean',

  // Garbage Collection
  gcPause: 'runtime.gc.pause',
  gcCount: 'runtime.gc.count',
  gcReclaimed: 'runtime.gc.reclaimed.bytes',

  // Process & System CPU
  cpuUtilization: 'runtime.cpu.utilization',
  cpuUser: 'runtime.cpu.user',
  cpuSystem: 'runtime.cpu.system',
  loadAvg1m: 'runtime.cpu.loadavg.1m',
  loadAvg5m: 'runtime.cpu.loadavg.5m',
  loadAvg15m: 'runtime.cpu.loadavg.15m',
  cgroupThrottledPeriods: 'container.cpu.throttling.periods',
  cgroupThrottledTimeMs: 'container.cpu.throttling.time_ms',

  // Host Memory & Storage
  systemMemoryFree: 'system.memory.free',
  systemMemoryTotal: 'system.memory.total',
  diskTotal: 'system.disk.total_bytes',
  diskFree: 'system.disk.free_bytes',
  diskUsedPercent: 'system.disk.used_percent',

  // GPU Hardware Acceleration
  gpuUtilization: 'gpu.utilization',
  gpuMemoryUsed: 'gpu.memory.used',
  gpuMemoryTotal: 'gpu.memory.total',
  gpuTemperature: 'gpu.temperature',
} as const

export interface RuntimeMetricsOptions {
  intervalMs?: number
  enabled?: boolean
  eventLoopMonitoring?: boolean
  gcMonitoring?: boolean
  cpuMonitoring?: boolean
  storageMonitoring?: boolean
  gpuMonitoring?: boolean
}

/**
 * Decodes numeric V8 GC bitflag constants into human-readable semantic strings.
 */
export function decodeGcKind(kind: number | string): string {
  if (typeof kind === 'string') {
    const num = parseInt(kind, 10)
    if (Number.isNaN(num)) return kind
    kind = num
  }

  const {
    NODE_PERFORMANCE_GC_MAJOR = 4,
    NODE_PERFORMANCE_GC_MINOR = 1,
    NODE_PERFORMANCE_GC_MINOR_MARK_SWEEP = 2,
    NODE_PERFORMANCE_GC_INCREMENTAL = 8,
    NODE_PERFORMANCE_GC_WEAKCB = 16,
  } = (perfConstants as unknown as Record<string, number>) || {}

  switch (kind) {
    case NODE_PERFORMANCE_GC_MINOR:
      return 'scavenge'
    case NODE_PERFORMANCE_GC_MINOR_MARK_SWEEP:
      return 'minor_mark_sweep'
    case NODE_PERFORMANCE_GC_MAJOR:
      return 'mark_sweep_compact'
    case NODE_PERFORMANCE_GC_INCREMENTAL:
      return 'incremental'
    case NODE_PERFORMANCE_GC_WEAKCB:
      return 'weak_callback'
    default:
      return `gc_${kind}`
  }
}

export class RuntimeMetricsSubsystem {
  private static instance: RuntimeMetricsSubsystem | null = null

  private intervalMs: number = 15000
  private eventLoopResolutionMs: number = 20
  private enabled: boolean = true
  private eventLoopMonitoring: boolean = true
  private gcMonitoring: boolean = true
  private cpuMonitoring: boolean = true
  private storageMonitoring: boolean = true
  private gpuMonitoring: boolean = true

  private timer: NodeJS.Timeout | null = null
  private lagHistogram: IntervalHistogram | null = null
  private gcObserver: PerformanceObserver | null = null
  private previousElu: ReturnType<typeof performance.eventLoopUtilization> | null = null
  private lastHeapUsedForGc: number = 0

  static getInstance(): RuntimeMetricsSubsystem {
    if (!RuntimeMetricsSubsystem.instance) {
      RuntimeMetricsSubsystem.instance = new RuntimeMetricsSubsystem()
    }
    return RuntimeMetricsSubsystem.instance
  }

  static resetInstance(): void {
    if (RuntimeMetricsSubsystem.instance) {
      RuntimeMetricsSubsystem.instance.stop()
      RuntimeMetricsSubsystem.instance = null
    }
  }

  configure(config: Readonly<RemoteConfigResponse>): void {
    this.enabled = config.features?.runtimeMetrics ?? true
    this.eventLoopMonitoring = config.features?.eventLoopMonitoring ?? true
    this.gcMonitoring = config.features?.gcMonitoring ?? true

    if (config.metrics?.pushIntervalMs) {
      this.intervalMs = config.metrics.pushIntervalMs
    }
    if (config.metrics?.eventLoopResolutionMs) {
      this.eventLoopResolutionMs = config.metrics.eventLoopResolutionMs
    }

    if (this.enabled) {
      if (this.timer) {
        this.restartTimer()
      } else {
        this.start()
      }
    } else {
      this.stop()
    }
  }

  private restartTimer(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.timer = setInterval(() => {
      this.collect()
    }, this.intervalMs)
    this.timer.unref()
  }

  handleConfigChange(diff: ConfigDiff, newConfig: Readonly<RemoteConfigResponse>): void {
    if (
      diff.changes.has('features.runtimeMetrics') ||
      diff.changes.has('features.eventLoopMonitoring') ||
      diff.changes.has('features.gcMonitoring') ||
      diff.changes.has('metrics.pushIntervalMs') ||
      diff.changes.has('metrics.eventLoopResolutionMs') ||
      diff.changes.has('metrics.runtimeMetrics') ||
      diff.changes.has('metrics.eventLoopMonitoring') ||
      diff.changes.has('metrics.gcMonitoring') ||
      Boolean(diff.metricsSectionChanged) ||
      Boolean(diff.metricsChanged)
    ) {
      this.configure(newConfig)
    }
  }

  start(options?: RuntimeMetricsOptions): void {
    if (options) {
      if (options.intervalMs) this.intervalMs = options.intervalMs
      if (options.enabled !== undefined) this.enabled = options.enabled
      if (options.eventLoopMonitoring !== undefined) this.eventLoopMonitoring = options.eventLoopMonitoring
      if (options.gcMonitoring !== undefined) this.gcMonitoring = options.gcMonitoring
      if (options.cpuMonitoring !== undefined) this.cpuMonitoring = options.cpuMonitoring
      if (options.storageMonitoring !== undefined) this.storageMonitoring = options.storageMonitoring
      if (options.gpuMonitoring !== undefined) this.gpuMonitoring = options.gpuMonitoring
    }

    if (!this.enabled) return
    if (this.timer) return // Already running

    const logger = getLogger()

    // 1. Enable Event Loop Delay Histogram if monitoring enabled
    if (this.eventLoopMonitoring && !this.lagHistogram) {
      try {
        this.lagHistogram = monitorEventLoopDelay({ resolution: this.eventLoopResolutionMs })
        this.lagHistogram.enable()
      } catch (err) {
        logger.debug('RuntimeMetricsSubsystem: monitorEventLoopDelay unsupported', { error: err })
      }
    }

    // 2. Initialize Event Loop Utilization baseline
    if (performance.eventLoopUtilization) {
      try {
        this.previousElu = performance.eventLoopUtilization()
      } catch {}
    }

    // 3. Initialize CPU Monitor baseline
    cpuMonitor.reset()

    // 4. Enable GC Observer if monitoring enabled
    if (this.gcMonitoring && !this.gcObserver) {
      try {
        this.lastHeapUsedForGc = process.memoryUsage().heapUsed
        this.gcObserver = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            if (entry.entryType === 'gc') {
              const rawKind = (entry as any).detail?.kind ?? (entry as any).kind ?? 'unknown'
              const semanticKind = decodeGcKind(rawKind)

              // Pause duration histogram
              recordHistogram(
                RUNTIME_METRIC_NAMES.gcPause,
                entry.duration,
                { gc_type: semanticKind, gc_kind: String(rawKind) },
                'ms'
              )

              // GC count counter
              incrementCounter(
                RUNTIME_METRIC_NAMES.gcCount,
                1,
                { gc_type: semanticKind },
                '1'
              )

              // Reclaimed memory estimation
              try {
                const currentHeapUsed = process.memoryUsage().heapUsed
                const reclaimed = Math.max(0, this.lastHeapUsedForGc - currentHeapUsed)
                this.lastHeapUsedForGc = currentHeapUsed
                if (reclaimed > 0) {
                  incrementCounter(
                    RUNTIME_METRIC_NAMES.gcReclaimed,
                    reclaimed,
                    { gc_type: semanticKind },
                    'bytes'
                  )
                }
              } catch {}
            }
          }
        })
        this.gcObserver.observe({ entryTypes: ['gc'] })
      } catch (err) {
        logger.debug('RuntimeMetricsSubsystem: PerformanceObserver gc unsupported', { error: err })
      }
    }

    // 5. Start periodic sample loop
    this.timer = setInterval(() => {
      this.collect()
    }, this.intervalMs)
    this.timer.unref()

    // Run initial collection
    this.collect()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }

    if (this.lagHistogram) {
      try {
        this.lagHistogram.disable()
      } catch {}
      this.lagHistogram = null
    }

    if (this.gcObserver) {
      try {
        this.gcObserver.disconnect()
      } catch {}
      this.gcObserver = null
    }

    this.previousElu = null
  }

  collect(): void {
    if (!this.enabled) return
    if (KillswitchEngine.getInstance()?.isKilled('disableMetrics')) return

    try {
      // ─── 1. Memory Metrics ────────────────────────────────────────────────
      const mem = process.memoryUsage()
      this.lastHeapUsedForGc = mem.heapUsed
      setGauge(RUNTIME_METRIC_NAMES.heapUsed, mem.heapUsed, undefined, 'bytes')
      setGauge(RUNTIME_METRIC_NAMES.heapTotal, mem.heapTotal, undefined, 'bytes')
      setGauge(RUNTIME_METRIC_NAMES.rss, mem.rss, undefined, 'bytes')
      setGauge(RUNTIME_METRIC_NAMES.external, mem.external, undefined, 'bytes')

      if ((mem as any).arrayBuffers !== undefined) {
        setGauge(RUNTIME_METRIC_NAMES.arrayBuffers, (mem as any).arrayBuffers, undefined, 'bytes')
      }

      // Host Memory
      try {
        setGauge(RUNTIME_METRIC_NAMES.systemMemoryFree, os.freemem(), undefined, 'bytes')
        setGauge(RUNTIME_METRIC_NAMES.systemMemoryTotal, os.totalmem(), undefined, 'bytes')
      } catch {}

      // ─── 2. Active Handles ────────────────────────────────────────────────
      try {
        if (typeof (process as any)._getActiveHandles === 'function') {
          const handles = (process as any)._getActiveHandles()
          if (Array.isArray(handles)) {
            setGauge(RUNTIME_METRIC_NAMES.handles, handles.length, undefined, '1')
          }
        }
      } catch {}

      // ─── 3. Event Loop Lag (p99 + percentiles) ────────────────────────────
      if (this.lagHistogram) {
        const nsToMs = (ns: number): number => Math.round((ns / 1_000_000) * 100) / 100
        const p99Ms = nsToMs(this.lagHistogram.percentile(99))
        setGauge(RUNTIME_METRIC_NAMES.eventLoopLag, p99Ms, undefined, 'ms')

        // Additional percentiles for enterprise root-cause diagnostics
        if (Number.isFinite(this.lagHistogram.mean)) {
          setGauge(RUNTIME_METRIC_NAMES.eventLoopLagP50, nsToMs(this.lagHistogram.percentile(50)), undefined, 'ms')
          setGauge(RUNTIME_METRIC_NAMES.eventLoopLagP90, nsToMs(this.lagHistogram.percentile(90)), undefined, 'ms')
          setGauge(RUNTIME_METRIC_NAMES.eventLoopLagP95, nsToMs(this.lagHistogram.percentile(95)), undefined, 'ms')
          setGauge(RUNTIME_METRIC_NAMES.eventLoopLagMax, nsToMs(this.lagHistogram.max), undefined, 'ms')
          setGauge(RUNTIME_METRIC_NAMES.eventLoopLagMean, nsToMs(this.lagHistogram.mean), undefined, 'ms')
        }
        this.lagHistogram.reset()
      }

      // ─── 4. Event Loop Utilization (ELU) ──────────────────────────────────
      if (performance.eventLoopUtilization) {
        try {
          const currentElu = performance.eventLoopUtilization(this.previousElu ?? undefined)
          this.previousElu = performance.eventLoopUtilization()
          setGauge(RUNTIME_METRIC_NAMES.eventLoopUtilization, Math.round(currentElu.utilization * 1000) / 1000, undefined, '1')
        } catch {}
      }

      // ─── 5. Process & System CPU Metrics ──────────────────────────────────
      if (this.cpuMonitoring) {
        const cpuStats = cpuMonitor.sample()
        setGauge(RUNTIME_METRIC_NAMES.cpuUtilization, cpuStats.normalizedCpuPercent, undefined, 'percent')
        setGauge(RUNTIME_METRIC_NAMES.cpuUser, cpuStats.userCpuPercent, undefined, 'percent')
        setGauge(RUNTIME_METRIC_NAMES.cpuSystem, cpuStats.systemCpuPercent, undefined, 'percent')
        setGauge(RUNTIME_METRIC_NAMES.loadAvg1m, cpuStats.loadAverage1m, undefined, '1')
        setGauge(RUNTIME_METRIC_NAMES.loadAvg5m, cpuStats.loadAverage5m, undefined, '1')
        setGauge(RUNTIME_METRIC_NAMES.loadAvg15m, cpuStats.loadAverage15m, undefined, '1')

        if (cpuStats.throttledPeriodsDelta !== undefined) {
          incrementCounter(RUNTIME_METRIC_NAMES.cgroupThrottledPeriods, cpuStats.throttledPeriodsDelta, undefined, '1')
        }
        if (cpuStats.throttledTimeMsDelta !== undefined) {
          incrementCounter(RUNTIME_METRIC_NAMES.cgroupThrottledTimeMs, cpuStats.throttledTimeMsDelta, undefined, 'ms')
        }
      }

      // ─── 6. Storage & Disk Capacity ───────────────────────────────────────
      if (this.storageMonitoring) {
        const storage = StorageDetector.sample()
        if (storage) {
          setGauge(RUNTIME_METRIC_NAMES.diskTotal, storage.totalBytes, undefined, 'bytes')
          setGauge(RUNTIME_METRIC_NAMES.diskFree, storage.freeBytes, undefined, 'bytes')
          setGauge(RUNTIME_METRIC_NAMES.diskUsedPercent, storage.usedPercent, undefined, 'percent')
        }
      }

      // ─── 7. GPU Acceleration ──────────────────────────────────────────────
      if (this.gpuMonitoring) {
        void gpuMonitor.sample().then((gpu) => {
          if (gpu) {
            setGauge(RUNTIME_METRIC_NAMES.gpuUtilization, gpu.averageUtilizationPercent, undefined, 'percent')
            setGauge(RUNTIME_METRIC_NAMES.gpuMemoryUsed, gpu.totalMemoryUsedBytes, undefined, 'bytes')
            setGauge(RUNTIME_METRIC_NAMES.gpuMemoryTotal, gpu.totalMemoryBytes, undefined, 'bytes')
            if (gpu.devices.length > 0 && gpu.devices[0]?.temperatureCelsius !== undefined) {
              setGauge(RUNTIME_METRIC_NAMES.gpuTemperature, gpu.devices[0].temperatureCelsius, undefined, 'celsius')
            }
          }
        }).catch(() => {})
      }
    } catch (err) {
      getLogger().debug('RuntimeMetricsSubsystem collect error', { error: err })
    }
  }
}
