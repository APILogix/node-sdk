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

import { EventEmitter } from 'events'
import { monitorEventLoopDelay, type IntervalHistogram } from 'perf_hooks'

export interface EventLoopLagStats {
  /** Minimum lag in milliseconds */
  readonly min: number
  /** Maximum lag in milliseconds */
  readonly max: number
  /** Mean lag in milliseconds */
  readonly mean: number
  /** 50th percentile (median) lag in milliseconds */
  readonly p50: number
  /** 95th percentile lag in milliseconds */
  readonly p95: number
  /** 99th percentile lag in milliseconds */
  readonly p99: number
  /** Standard deviation in milliseconds */
  readonly stddev: number
}

export interface EventLoopLagOptions {
  /** How often to emit 'lag' events (milliseconds). Default: 10000 */
  readonly emitIntervalMs?: number
  /** Resolution for the histogram (nanoseconds). Default: 20_000_000 (20ms) */
  readonly resolutionNs?: number
}

/**
 * Monitors the Node.js event loop delay using a high-resolution histogram.
 *
 * Emits:
 *   'lag' → { min, max, mean, p50, p95, p99, stddev } (all in ms)
 */
export class EventLoopLagMonitor extends EventEmitter {
  private readonly emitIntervalMs: number
  private readonly resolutionNs: number
  private histogram: IntervalHistogram | null = null
  private timer: NodeJS.Timeout | null = null

  constructor(options: EventLoopLagOptions = {}) {
    super()
    this.emitIntervalMs = options.emitIntervalMs ?? 10_000
    this.resolutionNs = options.resolutionNs ?? 20_000_000
  }

  /** Start monitoring the event loop. */
  start(): void {
    if (this.histogram) return

    this.histogram = monitorEventLoopDelay({ resolution: this.resolutionNs })
    this.histogram.enable()

    this.timer = setInterval(() => {
      this.emitStats()
    }, this.emitIntervalMs)

    // Don't hold the process open for monitoring
    this.timer.unref()
  }

  /** Stop monitoring and clean up. */
  stop(): void {
    if (this.histogram) {
      this.histogram.disable()
      this.histogram = null
    }
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** Reset the histogram to clear startup/warmup outliers. */
  reset(): void {
    if (this.histogram) {
      this.histogram.reset()
    }
  }

  /** Get current lag stats without emitting an event. */
  getStats(): EventLoopLagStats | null {
    if (!this.histogram) return null
    return this.extractHistogramStats(this.histogram)
  }

  /** Returns true if event loop lag p99 exceeds the given threshold (ms). */
  isLagging(thresholdMs: number): boolean {
    const stats = this.getStats()
    if (!stats) return false
    return stats.p99 > thresholdMs
  }

  private emitStats(): void {
    const stats = this.getStats()
    if (!stats) return

    this.emit('lag', stats)

    // Reset histogram for the next interval so stats are per-window
    this.histogram?.reset()
  }

  private extractHistogramStats(h: IntervalHistogram): EventLoopLagStats {
    return this.readHistogram(h)
  }

  private lastStats: EventLoopLagStats | null = null

  private readHistogram(h: IntervalHistogram): EventLoopLagStats {
    const nsToMs = (ns: number): number => {
      if (!Number.isFinite(ns) || ns < 0 || ns > 3_600_000_000_000) return 0
      return Math.round((ns / 1_000_000) * 100) / 100
    }
    const minRaw = h.min
    // When count === 0, perf_hooks reports min as 9223372036854776000 (2^63 - 1) and mean as NaN
    if (!Number.isFinite(h.mean) || minRaw > h.max || h.mean < 0) {
      return this.lastStats ?? { min: 0, max: 0, mean: 0, p50: 0, p95: 0, p99: 0, stddev: 0 }
    }
    const stats: EventLoopLagStats = {
      min: nsToMs(minRaw),
      max: nsToMs(h.max),
      mean: nsToMs(h.mean),
      p50: nsToMs(h.percentile(50)),
      p95: nsToMs(h.percentile(95)),
      p99: nsToMs(h.percentile(99)),
      stddev: nsToMs(h.stddev),
    }
    this.lastStats = stats
    return stats
  }
}
