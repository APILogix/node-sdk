/**
 * Enterprise Metrics Registry — OTel-native compatibility wrapper.
 *
 * ALL metric aggregation is delegated to the OTel MeterProvider:
 * - Histograms: OTel ExponentialHistogram (O(1) per record)
 * - Counters: OTel Counter
 * - Gauges: OTel Gauge
 * - UpDownCounters: OTel UpDownCounter
 *
 * NO custom percentile computation. Backend computes from raw histogram buckets.
 * This eliminates the previous architecture's 95% p99 error caused by
 * sort-based percentile calculation on small sample windows.
 *
 * Provides:
 * - Same public API as v2 (backward compatible)
 * - Cardinality protection via CardinalityGovernor
 * - Memory-safe bounded instrument count
 * - Auto-flush lifecycle management
 *
 * Architecture:
 *   MetricsRegistry → OtelMetricsManager → MeterProvider → ExponentialHistogramAggregation → LynkTraceMetricReader → EventPipeline
 */

import { getLogger } from '../utils/logger.js'
import { otelMetrics } from './otel-adapter.js'
import { cardinalityGovernor } from '../utils/cardinality-governor.js'

// ─── Types ──────────────────────────────────────────────────────────────────

export interface MetricLabels {
    [key: string]: string
}

export interface MetricOptions {
    labels?: MetricLabels | undefined
    timestamp?: number | undefined
    unit?: string | undefined
}

export interface HistogramOptions {
    /** Bucket boundaries (ignored in OTel mode — exponential buckets used). */
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
    /** Default histogram boundaries (ignored in OTel mode). */
    defaultHistogramBoundaries?: number[]
    /** Default max cardinality per metric. Default: 1000 */
    defaultMaxCardinality?: number
}

export interface AggregatedMetric {
    name: string
    type: string
    labels: MetricLabels
    timestamp: number
    value: number
    count: number
    sum: number
    min: number
    max: number
    avg: number
    rate: number
}

// ─── Metrics Registry (OTel-native wrapper) ─────────────────────────────────

class MetricsRegistry {
    private readonly maxMetrics: number
    private readonly defaultMaxCardinality: number
    private initialized = false
    private totalFlushed = 0
    private totalDropped = 0
    private registeredMetrics = new Set<string>()

    constructor(options: MetricRegistryOptions = {}) {
        this.maxMetrics = options.maxMetrics ?? 500
        this.defaultMaxCardinality = options.defaultMaxCardinality ?? 1000
    }

    start(): void {
        if (this.initialized) return
        this.initialized = true
    }

    stop(): void {
        this.initialized = false
    }

    /**
     * Record a histogram value.
     * Delegates to OTel ExponentialHistogram — O(1) per record.
     * Backend computes percentiles from raw bucket data.
     */
    recordHistogram(name: string, value: number, options: MetricOptions & HistogramOptions = {}): void {
        if (!this.initialized) return

        if (!this.canRegisterMetric(name)) {
            this.totalDropped++
            return
        }

        const labels = options.labels ?? {}
        const sanitized = cardinalityGovernor.sanitizeAttributes(name, labels)
        const seriesKey = serializeLabels(sanitized)

        if (!cardinalityGovernor.canRecordSeries(name, seriesKey)) {
            this.totalDropped++
            return
        }

        if (otelMetrics.isInitialized()) {
            otelMetrics.recordHistogram(name, value, sanitized, options.unit)
            this.totalFlushed++
        } else {
            getLogger().debug('Histogram recorded but OTel metrics not initialized', { name })
        }
    }

    incrementCounter(name: string, value: number = 1, options: MetricOptions & CounterOptions = {}): void {
        if (!this.initialized) return

        if (!this.canRegisterMetric(name)) {
            this.totalDropped++
            return
        }

        const labels = options.labels ?? {}
        const sanitized = cardinalityGovernor.sanitizeAttributes(name, labels)
        const seriesKey = serializeLabels(sanitized)

        if (!cardinalityGovernor.canRecordSeries(name, seriesKey)) {
            this.totalDropped++
            return
        }

        if (otelMetrics.isInitialized()) {
            otelMetrics.incrementCounter(name, value, sanitized, options.unit)
            this.totalFlushed++
        }
    }

    addUpDownCounter(name: string, value: number, options: MetricOptions & CounterOptions = {}): void {
        if (!this.initialized) return

        if (!this.canRegisterMetric(name)) {
            this.totalDropped++
            return
        }

        const labels = options.labels ?? {}
        const sanitized = cardinalityGovernor.sanitizeAttributes(name, labels)
        const seriesKey = serializeLabels(sanitized)

        if (!cardinalityGovernor.canRecordSeries(name, seriesKey)) {
            this.totalDropped++
            return
        }

        if (otelMetrics.isInitialized()) {
            otelMetrics.addUpDownCounter(name, value, sanitized, options.unit)
            this.totalFlushed++
        }
    }

    setGauge(name: string, value: number, options: MetricOptions & CounterOptions = {}): void {
        if (!this.initialized) return

        if (!this.canRegisterMetric(name)) {
            this.totalDropped++
            return
        }

        const labels = options.labels ?? {}
        const sanitized = cardinalityGovernor.sanitizeAttributes(name, labels)
        const seriesKey = serializeLabels(sanitized)

        if (!cardinalityGovernor.canRecordSeries(name, seriesKey)) {
            this.totalDropped++
            return
        }

        if (otelMetrics.isInitialized()) {
            otelMetrics.setGauge(name, value, sanitized, options.unit)
            this.totalFlushed++
        }
    }

    /**
     * Flush pending metrics through the OTel reader → event pipeline.
     */
    async flush(internalTelemetry = false): Promise<void> {
        if (otelMetrics.isInitialized()) {
            try {
                await otelMetrics.flush(internalTelemetry)
            } catch {
                // Best-effort: the next normal flush cycle will retry.
            }
        }
    }

    getStats(): {
        initialized: boolean
        registeredMetrics: number
        totalFlushed: number
        totalDropped: number
        cardinalityStats: ReturnType<typeof cardinalityGovernor.getStats>
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
            registeredMetrics: this.registeredMetrics.size,
            totalFlushed: this.totalFlushed,
            totalDropped: this.totalDropped,
            cardinalityStats: cardinalityGovernor.getStats(),
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
        this.registeredMetrics.clear()
        this.totalFlushed = 0
        this.totalDropped = 0
        cardinalityGovernor.reset()
    }

    // ─── Internal ───────────────────────────────────────────────────────────

    private canRegisterMetric(name: string): boolean {
        if (this.registeredMetrics.has(name)) return true
        if (this.registeredMetrics.size >= this.maxMetrics) return false
        this.registeredMetrics.add(name)
        return true
    }
}

// ─── Utilities ──────────────────────────────────────────────────────────────

/**
 * Serializes metric labels into a canonical key.
 * Fast, allocation-conscious implementation eliminating JSON.stringify,
 * localeCompare, and intermediate arrays on hot recording paths (SEC-06).
 */
export function serializeLabels(labels: Record<string, string>): string {
    if (!labels) return ''
    const keys = Object.keys(labels)
    const len = keys.length
    if (len === 0) return ''

    if (len === 1) {
        const k0 = keys[0]!
        return `${k0}=${labels[k0] ?? ''}`
    }

    if (len === 2) {
        const k0 = keys[0]!
        const k1 = keys[1]!
        if (k0 < k1) {
            return `${k0}=${labels[k0] ?? ''},${k1}=${labels[k1] ?? ''}`
        }
        return `${k1}=${labels[k1] ?? ''},${k0}=${labels[k0] ?? ''}`
    }

    if (len === 3) {
        let k0 = keys[0]!, k1 = keys[1]!, k2 = keys[2]!
        if (k0 > k1) { const t = k0; k0 = k1; k1 = t; }
        if (k1 > k2) { const t = k1; k1 = k2; k2 = t; }
        if (k0 > k1) { const t = k0; k0 = k1; k1 = t; }
        return `${k0}=${labels[k0] ?? ''},${k1}=${labels[k1] ?? ''},${k2}=${labels[k2] ?? ''}`
    }

    if (len === 4) {
        let k0 = keys[0]!, k1 = keys[1]!, k2 = keys[2]!, k3 = keys[3]!
        if (k0 > k1) { const t = k0; k0 = k1; k1 = t; }
        if (k2 > k3) { const t = k2; k2 = k3; k3 = t; }
        if (k0 > k2) { const t = k0; k0 = k2; k2 = t; }
        if (k1 > k3) { const t = k1; k1 = k3; k3 = t; }
        if (k1 > k2) { const t = k1; k1 = k2; k2 = t; }
        return `${k0}=${labels[k0] ?? ''},${k1}=${labels[k1] ?? ''},${k2}=${labels[k2] ?? ''},${k3}=${labels[k3] ?? ''}`
    }

    keys.sort()
    let result = ''
    for (let i = 0; i < len; i++) {
        if (i > 0) result += ','
        const key = keys[i]!
        result += key + '=' + (labels[key] ?? '')
    }
    return result
}

// ─── Singleton ──────────────────────────────────────────────────────────────

export const metricsRegistry = new MetricsRegistry()
export { MetricsRegistry }
export type { AggregatedMetric as AggregatedMetricLegacy }
