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

import { monitorEventLoopDelay, performance, PerformanceObserver, type IntervalHistogram } from 'node:perf_hooks'
import { getLogger } from '../utils/logger.js'
import { setGauge, recordHistogram } from '../capture/captureMetric.js'
import type { RemoteConfigResponse, ConfigDiff } from '../types/config.js'
import { KillswitchEngine } from '../core/killswitch-engine.js'

export const RUNTIME_METRIC_NAMES = {
  heapUsed: 'runtime.heap.used',
  heapTotal: 'runtime.heap.total',
  external: 'runtime.memory.external',
  rss: 'runtime.memory.rss',
  handles: 'runtime.handles.active',
  eventLoopLag: 'runtime.eventloop.lag',
  eventLoopUtilization: 'runtime.eventloop.utilization',
  gcPause: 'runtime.gc.pause',
} as const

export interface RuntimeMetricsOptions {
  intervalMs?: number
  enabled?: boolean
  eventLoopMonitoring?: boolean
  gcMonitoring?: boolean
}

export class RuntimeMetricsSubsystem {
  private static instance: RuntimeMetricsSubsystem | null = null

  private intervalMs: number = 15000
  private enabled: boolean = true
  private eventLoopMonitoring: boolean = true
  private gcMonitoring: boolean = true

  private timer: NodeJS.Timeout | null = null
  private lagHistogram: IntervalHistogram | null = null
  private gcObserver: PerformanceObserver | null = null
  private previousElu: ReturnType<typeof performance.eventLoopUtilization> | null = null

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

    if (this.enabled) {
      this.start()
    } else {
      this.stop()
    }
  }

  handleConfigChange(diff: ConfigDiff, newConfig: Readonly<RemoteConfigResponse>): void {
    if (
      diff.changes.has('features.runtimeMetrics') ||
      diff.changes.has('features.eventLoopMonitoring') ||
      diff.changes.has('features.gcMonitoring')
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
    }

    if (!this.enabled) return
    if (this.timer) return // Already running

    const logger = getLogger()

    // 1. Enable Event Loop Delay Histogram if monitoring enabled
    if (this.eventLoopMonitoring && !this.lagHistogram) {
      try {
        this.lagHistogram = monitorEventLoopDelay({ resolution: 20 })
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

    // 3. Enable GC Observer if monitoring enabled
    if (this.gcMonitoring && !this.gcObserver) {
      try {
        this.gcObserver = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            if (entry.entryType === 'gc') {
              const gcKind = (entry as any).detail?.kind ?? (entry as any).kind ?? 'unknown'
              recordHistogram(RUNTIME_METRIC_NAMES.gcPause, entry.duration, { gc_type: String(gcKind) }, 'ms')
            }
          }
        })
        this.gcObserver.observe({ entryTypes: ['gc'] })
      } catch (err) {
        logger.debug('RuntimeMetricsSubsystem: PerformanceObserver gc unsupported', { error: err })
      }
    }

    // 4. Start periodic sample loop
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
      // Memory metrics
      const mem = process.memoryUsage()
      setGauge(RUNTIME_METRIC_NAMES.heapUsed, mem.heapUsed)
      setGauge(RUNTIME_METRIC_NAMES.heapTotal, mem.heapTotal)
      setGauge(RUNTIME_METRIC_NAMES.rss, mem.rss)
      setGauge(RUNTIME_METRIC_NAMES.external, mem.external)

      // Active handles
      if (typeof (process as any)._getActiveHandles === 'function') {
        const handles = (process as any)._getActiveHandles()
        if (Array.isArray(handles)) {
          setGauge(RUNTIME_METRIC_NAMES.handles, handles.length)
        }
      }

      // Event loop lag (p99)
      if (this.lagHistogram) {
        const lagMs = this.lagHistogram.percentile(99) / 1e6
        setGauge(RUNTIME_METRIC_NAMES.eventLoopLag, Math.round(lagMs * 100) / 100)
        this.lagHistogram.reset()
      }

      // Event loop utilization (0.0 to 1.0)
      if (performance.eventLoopUtilization) {
        const currentElu = performance.eventLoopUtilization(this.previousElu ?? undefined)
        this.previousElu = performance.eventLoopUtilization()
        setGauge(RUNTIME_METRIC_NAMES.eventLoopUtilization, Math.round(currentElu.utilization * 1000) / 1000)
      }
    } catch (err) {
      getLogger().debug('RuntimeMetricsSubsystem collect error', { error: err })
    }
  }
}
