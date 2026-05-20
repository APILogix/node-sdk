/**
 * Enterprise Metrics Registry — hybrid architecture:
 * - Histograms: Powered by OpenTelemetry exponential histograms (O(1) per record)
 * - Counters/Gauges: Custom windowed aggregation (lightweight, no OTel overhead)
 *
 * Provides:
 * - ExponentialHistogram with OTel for high-precision latency percentiles
 * - Windowed Counter aggregation (sum over configurable intervals)
 * - Gauge (last-value, point-in-time)
 * - UpDownCounter (monotonic up/down tracking)
 * - Cardinality protection per metric
 * - Automatic flush on interval
 * - Memory-safe bounded storage
 *
 * Architecture:
 *   Histogram → OTel MeterProvider → ExponentialHistogramAggregation → PulseMetricReader → EventPipeline
 *   Counter/Gauge → Custom Aggregator → EventPipeline
 */

import { getLogger } from '../utils/logger.js'
import { epochMs } from '../utils/time.js'
import { generateId } from '../utils/uuid.js'
import { captureEvent } from '../capture/captureEvent.js'
import { otelMetrics } from './otel-adapter.js'
import type { MetricEvent, MetricType } from '../types/event.js'

// ─── Types ──────────────────────────────────────────────────────────────────

export interface MetricLabels {
  [key: string]: string
}

export interface MetricOptions {
  labels?: MetricLabels
  timestamp?: number
}

export interface HistogramOptions {
  /** Bucket boundaries for histogram. Used as fallback if OTel not available. */
  boundaries?: number[]
  /** Max unique label combinations per metric. Default: 1000 */
  maxCardinality?: number
}

export interface CounterOptions {
  /** Max unique label combinations per metric. Default: 1000 */
  maxCardinality?: number
}

export interface MetricRegistryOptions {
  /** Flush interval in milliseconds. Default: 10000 (10s) */
  flushIntervalMs?: number
  /** Max unique metrics in registry. Default: 500 */
  maxMetrics?: number
  /** Default histogram boundaries */
  defaultHistogramBoundaries?: number[]
  /** Default max cardinality per metric. Default: 1000 */
  defaultMaxCardinality?: number
}

interface AggregatedMetric {
  name: string
  type: MetricType | 'updown_counter' | 'summary'
  labels: MetricLabels
  timestamp: number
  value: number
  count: number
  sum: number
  min: number
  max: number
  p50: number
  p75: number
  p90: number
  p95: number
  p99: number
  avg: number
  rate: number
}

// ─── Histogram Aggregator (fallback when OTel unavailable) ──────────────────

class HistogramAggregator {
  private readonly boundaries: number[]
  private readonly maxCardinality: number
  private values: number[] = []
  private labelSets = new Map<string, number[]>()
  private count = 0
  private sum = 0
  private min = Infinity
  private max = -Infinity

  constructor(options: HistogramOptions = {}) {
    this.boundaries = options.boundaries ?? [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000]
    this.maxCardinality = options.maxCardinality ?? 1000
  }

  record(value: number, labels: MetricLabels = {}): void {
    const key = this.labelKey(labels)

    if (!this.labelSets.has(key)) {
      if (this.labelSets.size >= this.maxCardinality) {
        getLogger().warn('Metric cardinality limit reached', {
          metric: 'histogram',
          cardinality: this.labelSets.size,
          maxCardinality: this.maxCardinality,
        })
        return
      }
      this.labelSets.set(key, [])
    }

    const bucket = this.labelSets.get(key)!
    bucket.push(value)
    this.values.push(value)
    this.count++
    this.sum += value
    if (value < this.min) this.min = value
    if (value > this.max) this.max = value
  }

  flush(): AggregatedMetric[] {
    const results: AggregatedMetric[] = []
    const now = epochMs()

    if (this.values.length > 0) {
      const sorted = [...this.values].sort((a, b) => a - b)
      results.push({
        name: '_global',
        type: 'histogram',
        labels: {},
        timestamp: now,
        value: 0,
        count: this.count,
        sum: this.sum,
        min: this.min === Infinity ? 0 : this.min,
        max: this.max === -Infinity ? 0 : this.max,
        p50: percentile(sorted, 50),
        p75: percentile(sorted, 75),
        p90: percentile(sorted, 90),
        p95: percentile(sorted, 95),
        p99: percentile(sorted, 99),
        avg: this.sum / this.count,
        rate: 0,
      })
    }

    for (const [key, vals] of this.labelSets.entries()) {
      if (vals.length === 0) continue
      const sorted = [...vals].sort((a, b) => a - b)
      const labels = this.parseLabelKey(key)
      results.push({
        name: key,
        type: 'histogram',
        labels,
        timestamp: now,
        value: 0,
        count: vals.length,
        sum: vals.reduce((a, b) => a + b, 0),
        min: sorted[0] ?? 0,
        max: sorted[sorted.length - 1] ?? 0,
        p50: percentile(sorted, 50),
        p75: percentile(sorted, 75),
        p90: percentile(sorted, 90),
        p95: percentile(sorted, 95),
        p99: percentile(sorted, 99),
        avg: sorted.reduce((a, b) => a + b, 0) / sorted.length,
        rate: 0,
      })
    }

    this.reset()
    return results
  }

  reset(): void {
    this.values = []
    this.labelSets.clear()
    this.count = 0
    this.sum = 0
    this.min = Infinity
    this.max = -Infinity
  }

  private labelKey(labels: MetricLabels): string {
    return Object.entries(labels)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join(',')
  }

  private parseLabelKey(key: string): MetricLabels {
    if (!key) return {}
    const labels: MetricLabels = {}
    for (const pair of key.split(',')) {
      const [k, ...rest] = pair.split('=')
      if (k) labels[k] = rest.join('=')
    }
    return labels
  }
}

// ─── Windowed Counter ───────────────────────────────────────────────────────

class WindowedCounter {
  private readonly maxCardinality: number
  private readonly windowMs: number
  private windows = new Map<string, { value: number; start: number }>()
  private labelSets = new Set<string>()

  constructor(options: CounterOptions = {}, windowMs = 10000) {
    this.maxCardinality = options.maxCardinality ?? 1000
    this.windowMs = windowMs
  }

  add(value: number, labels: MetricLabels = {}): void {
    const key = this.labelKey(labels)

    if (!this.labelSets.has(key)) {
      if (this.labelSets.size >= this.maxCardinality) {
        getLogger().warn('Metric cardinality limit reached', {
          metric: 'counter',
          cardinality: this.labelSets.size,
          maxCardinality: this.maxCardinality,
        })
        return
      }
      this.labelSets.add(key)
    }

    const now = epochMs()
    const window = this.windows.get(key)

    if (!window || now - window.start > this.windowMs) {
      this.windows.set(key, { value, start: now })
    } else {
      window.value += value
    }
  }

  flush(): AggregatedMetric[] {
    const results: AggregatedMetric[] = []
    const now = epochMs()

    for (const [key, window] of this.windows.entries()) {
      if (window.value === 0) continue
      const labels = this.parseLabelKey(key)
      results.push({
        name: key,
        type: 'counter',
        labels,
        timestamp: now,
        value: window.value,
        count: 1,
        sum: window.value,
        min: window.value,
        max: window.value,
        p50: window.value,
        p75: window.value,
        p90: window.value,
        p95: window.value,
        p99: window.value,
        avg: window.value,
        rate: window.value / (this.windowMs / 1000),
      })
    }

    this.windows.clear()
    return results
  }

  private labelKey(labels: MetricLabels): string {
    return Object.entries(labels)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join(',')
  }

  private parseLabelKey(key: string): MetricLabels {
    if (!key) return {}
    const labels: MetricLabels = {}
    for (const pair of key.split(',')) {
      const [k, ...rest] = pair.split('=')
      if (k) labels[k] = rest.join('=')
    }
    return labels
  }
}

// ─── UpDownCounter ──────────────────────────────────────────────────────────

class UpDownCounter {
  private readonly maxCardinality: number
  private values = new Map<string, number>()
  private labelSets = new Set<string>()

  constructor(options: CounterOptions = {}) {
    this.maxCardinality = options.maxCardinality ?? 1000
  }

  add(value: number, labels: MetricLabels = {}): void {
    const key = this.labelKey(labels)

    if (!this.labelSets.has(key)) {
      if (this.labelSets.size >= this.maxCardinality) {
        getLogger().warn('Metric cardinality limit reached', {
          metric: 'updown_counter',
          cardinality: this.labelSets.size,
          maxCardinality: this.maxCardinality,
        })
        return
      }
      this.labelSets.add(key)
    }

    const current = this.values.get(key) ?? 0
    this.values.set(key, current + value)
  }

  set(value: number, labels: MetricLabels = {}): void {
    const key = this.labelKey(labels)

    if (!this.labelSets.has(key)) {
      if (this.labelSets.size >= this.maxCardinality) {
        getLogger().warn('Metric cardinality limit reached', {
          metric: 'updown_counter',
          cardinality: this.labelSets.size,
          maxCardinality: this.maxCardinality,
        })
        return
      }
      this.labelSets.add(key)
    }

    this.values.set(key, value)
  }

  flush(): AggregatedMetric[] {
    const results: AggregatedMetric[] = []
    const now = epochMs()

    for (const [key, value] of this.values.entries()) {
      const labels = this.parseLabelKey(key)
      results.push({
        name: key,
        type: 'gauge',
        labels,
        timestamp: now,
        value,
        count: 1,
        sum: value,
        min: value,
        max: value,
        p50: value,
        p75: value,
        p90: value,
        p95: value,
        p99: value,
        avg: value,
        rate: 0,
      })
    }

    return results
  }

  private labelKey(labels: MetricLabels): string {
    return Object.entries(labels)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join(',')
  }

  private parseLabelKey(key: string): MetricLabels {
    if (!key) return {}
    const labels: MetricLabels = {}
    for (const pair of key.split(',')) {
      const [k, ...rest] = pair.split('=')
      if (k) labels[k] = rest.join('=')
    }
    return labels
  }
}

// ─── Gauge ──────────────────────────────────────────────────────────────────

class GaugeAggregator {
  private readonly maxCardinality: number
  private values = new Map<string, { value: number; timestamp: number }>()
  private labelSets = new Set<string>()

  constructor(options: CounterOptions = {}) {
    this.maxCardinality = options.maxCardinality ?? 1000
  }

  set(value: number, labels: MetricLabels = {}): void {
    const key = this.labelKey(labels)

    if (!this.labelSets.has(key)) {
      if (this.labelSets.size >= this.maxCardinality) {
        getLogger().warn('Metric cardinality limit reached', {
          metric: 'gauge',
          cardinality: this.labelSets.size,
          maxCardinality: this.maxCardinality,
        })
        return
      }
      this.labelSets.add(key)
    }

    this.values.set(key, { value, timestamp: epochMs() })
  }

  flush(): AggregatedMetric[] {
    const results: AggregatedMetric[] = []

    for (const [key, entry] of this.values.entries()) {
      const labels = this.parseLabelKey(key)
      results.push({
        name: key,
        type: 'gauge',
        labels,
        timestamp: entry.timestamp,
        value: entry.value,
        count: 1,
        sum: entry.value,
        min: entry.value,
        max: entry.value,
        p50: entry.value,
        p75: entry.value,
        p90: entry.value,
        p95: entry.value,
        p99: entry.value,
        avg: entry.value,
        rate: 0,
      })
    }

    return results
  }

  private labelKey(labels: MetricLabels): string {
    return Object.entries(labels)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join(',')
  }

  private parseLabelKey(key: string): MetricLabels {
    if (!key) return {}
    const labels: MetricLabels = {}
    for (const pair of key.split(',')) {
      const [k, ...rest] = pair.split('=')
      if (k) labels[k] = rest.join('=')
    }
    return labels
  }
}

// ─── Metrics Registry (Hybrid) ──────────────────────────────────────────────

class MetricsRegistry {
  private fallbackHistograms = new Map<string, HistogramAggregator>()
  private counters = new Map<string, WindowedCounter>()
  private upDownCounters = new Map<string, UpDownCounter>()
  private gauges = new Map<string, GaugeAggregator>()
  private flushTimer: ReturnType<typeof setInterval> | null = null
  private flushIntervalMs: number
  private maxMetrics: number
  private defaultBoundaries: number[]
  private defaultMaxCardinality: number
  private initialized = false
  private totalFlushed = 0
  private totalDropped = 0

  constructor(options: MetricRegistryOptions = {}) {
    this.flushIntervalMs = options.flushIntervalMs ?? 10000
    this.maxMetrics = options.maxMetrics ?? 500
    this.defaultBoundaries = options.defaultHistogramBoundaries ?? [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000]
    this.defaultMaxCardinality = options.defaultMaxCardinality ?? 1000
  }

  start(): void {
    if (this.initialized) return
    this.initialized = true
    this.flushTimer = setInterval(() => this.flush(), this.flushIntervalMs)
    this.flushTimer.unref()
  }

  stop(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer)
      this.flushTimer = null
    }
    this.initialized = false
  }

  /**
   * Record a histogram value.
   * Uses OTel exponential histogram when available (O(1) per record).
   * Falls back to custom aggregator if OTel not initialized.
   */
  recordHistogram(name: string, value: number, options: MetricOptions & HistogramOptions = {}): void {
    if (!this.initialized) return

    if (otelMetrics.isInitialized()) {
      otelMetrics.recordHistogram(name, value, options.labels ?? {})
      return
    }

    if (this.fallbackHistograms.size >= this.maxMetrics && !this.fallbackHistograms.has(name)) {
      this.totalDropped++
      return
    }

    let agg = this.fallbackHistograms.get(name)
    if (!agg) {
      agg = new HistogramAggregator({
        boundaries: options.boundaries ?? this.defaultBoundaries,
        maxCardinality: options.maxCardinality ?? this.defaultMaxCardinality,
      })
      this.fallbackHistograms.set(name, agg)
    }

    agg.record(value, options.labels ?? {})
  }

  incrementCounter(name: string, value: number = 1, options: MetricOptions & CounterOptions = {}): void {
    if (!this.initialized) return

    if (this.counters.size >= this.maxMetrics && !this.counters.has(name)) {
      this.totalDropped++
      return
    }

    let agg = this.counters.get(name)
    if (!agg) {
      agg = new WindowedCounter(
        { maxCardinality: options.maxCardinality ?? this.defaultMaxCardinality },
        this.flushIntervalMs
      )
      this.counters.set(name, agg)
    }

    agg.add(value, options.labels ?? {})
  }

  addUpDownCounter(name: string, value: number, options: MetricOptions & CounterOptions = {}): void {
    if (!this.initialized) return

    if (this.upDownCounters.size >= this.maxMetrics && !this.upDownCounters.has(name)) {
      this.totalDropped++
      return
    }

    let agg = this.upDownCounters.get(name)
    if (!agg) {
      agg = new UpDownCounter({ maxCardinality: options.maxCardinality ?? this.defaultMaxCardinality })
      this.upDownCounters.set(name, agg)
    }

    agg.add(value, options.labels ?? {})
  }

  setGauge(name: string, value: number, options: MetricOptions & CounterOptions = {}): void {
    if (!this.initialized) return

    if (this.gauges.size >= this.maxMetrics && !this.gauges.has(name)) {
      this.totalDropped++
      return
    }

    let agg = this.gauges.get(name)
    if (!agg) {
      agg = new GaugeAggregator({ maxCardinality: options.maxCardinality ?? this.defaultMaxCardinality })
      this.gauges.set(name, agg)
    }

    agg.set(value, options.labels ?? {})
  }

  flush(): void {
    const aggregated: AggregatedMetric[] = []

    if (otelMetrics.isInitialized()) {
      otelMetrics.flush().catch(() => {})
    }

    for (const [name, agg] of this.fallbackHistograms.entries()) {
      const results = agg.flush()
      for (const r of results) {
        r.name = name
        aggregated.push(r)
      }
    }

    for (const [name, agg] of this.counters.entries()) {
      const results = agg.flush()
      for (const r of results) {
        r.name = name
        aggregated.push(r)
      }
    }

    for (const [name, agg] of this.upDownCounters.entries()) {
      const results = agg.flush()
      for (const r of results) {
        r.name = name
        aggregated.push(r)
      }
    }

    for (const [name, agg] of this.gauges.entries()) {
      const results = agg.flush()
      for (const r of results) {
        r.name = name
        aggregated.push(r)
      }
    }

    for (const metric of aggregated) {
      const event = {
        type: 'metric' as const,
        eventId: generateId(),
        metricName: metric.name,
        metricType: metric.type as MetricType,
        value: metric.value,
        timestamp: metric.timestamp,
        tags: metric.labels,
        count: metric.count,
        sum: metric.sum,
        min: metric.min,
        max: metric.max,
        p50: metric.p50,
        p75: metric.p75,
        p90: metric.p90,
        p95: metric.p95,
        p99: metric.p99,
        avg: metric.avg,
        rate: metric.rate,
      } as unknown as MetricEvent

      captureEvent(event)
      this.totalFlushed++
    }
  }

  getStats(): {
    initialized: boolean
    histogramCount: number
    counterCount: number
    upDownCounterCount: number
    gaugeCount: number
    totalFlushed: number
    totalDropped: number
    otelStats?: {
      histogramCount: number
      counterCount: number
      upDownCounterCount: number
      gaugeCount: number
    } | undefined
  } {
    const otelStats = otelMetrics.getStats()
    return {
      initialized: this.initialized,
      histogramCount: this.fallbackHistograms.size,
      counterCount: this.counters.size,
      upDownCounterCount: this.upDownCounters.size,
      gaugeCount: this.gauges.size,
      totalFlushed: this.totalFlushed,
      totalDropped: this.totalDropped,
      otelStats: otelStats.initialized
        ? {
            histogramCount: otelStats.histogramCount,
            counterCount: otelStats.counterCount,
            upDownCounterCount: otelStats.upDownCounterCount,
            gaugeCount: otelStats.gaugeCount,
          }
        : undefined,
    }
  }

  reset(): void {
    this.fallbackHistograms.clear()
    this.counters.clear()
    this.upDownCounters.clear()
    this.gauges.clear()
    this.totalFlushed = 0
    this.totalDropped = 0
  }
}

// ─── Utilities ──────────────────────────────────────────────────────────────

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const index = Math.ceil((p / 100) * sorted.length) - 1
  const safeIndex = Math.max(0, Math.min(index, sorted.length - 1))
  return sorted[safeIndex] ?? 0
}

// ─── Singleton ──────────────────────────────────────────────────────────────

export const metricsRegistry = new MetricsRegistry()
export { MetricsRegistry }
export type { AggregatedMetric }
