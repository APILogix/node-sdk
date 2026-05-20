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
import type { MetricType } from '../types/event.js';
export interface MetricLabels {
    [key: string]: string;
}
export interface MetricOptions {
    labels?: MetricLabels;
    timestamp?: number;
}
export interface HistogramOptions {
    /** Bucket boundaries for histogram. Used as fallback if OTel not available. */
    boundaries?: number[];
    /** Max unique label combinations per metric. Default: 1000 */
    maxCardinality?: number;
}
export interface CounterOptions {
    /** Max unique label combinations per metric. Default: 1000 */
    maxCardinality?: number;
}
export interface MetricRegistryOptions {
    /** Flush interval in milliseconds. Default: 10000 (10s) */
    flushIntervalMs?: number;
    /** Max unique metrics in registry. Default: 500 */
    maxMetrics?: number;
    /** Default histogram boundaries */
    defaultHistogramBoundaries?: number[];
    /** Default max cardinality per metric. Default: 1000 */
    defaultMaxCardinality?: number;
}
interface AggregatedMetric {
    name: string;
    type: MetricType | 'updown_counter' | 'summary';
    labels: MetricLabels;
    timestamp: number;
    value: number;
    count: number;
    sum: number;
    min: number;
    max: number;
    p50: number;
    p75: number;
    p90: number;
    p95: number;
    p99: number;
    avg: number;
    rate: number;
}
declare class MetricsRegistry {
    private fallbackHistograms;
    private counters;
    private upDownCounters;
    private gauges;
    private flushTimer;
    private flushIntervalMs;
    private maxMetrics;
    private defaultBoundaries;
    private defaultMaxCardinality;
    private initialized;
    private totalFlushed;
    private totalDropped;
    constructor(options?: MetricRegistryOptions);
    start(): void;
    stop(): void;
    /**
     * Record a histogram value.
     * Uses OTel exponential histogram when available (O(1) per record).
     * Falls back to custom aggregator if OTel not initialized.
     */
    recordHistogram(name: string, value: number, options?: MetricOptions & HistogramOptions): void;
    incrementCounter(name: string, value?: number, options?: MetricOptions & CounterOptions): void;
    addUpDownCounter(name: string, value: number, options?: MetricOptions & CounterOptions): void;
    setGauge(name: string, value: number, options?: MetricOptions & CounterOptions): void;
    flush(): void;
    getStats(): {
        initialized: boolean;
        histogramCount: number;
        counterCount: number;
        upDownCounterCount: number;
        gaugeCount: number;
        totalFlushed: number;
        totalDropped: number;
        otelStats?: {
            histogramCount: number;
            counterCount: number;
            upDownCounterCount: number;
            gaugeCount: number;
        } | undefined;
    };
    reset(): void;
}
export declare const metricsRegistry: MetricsRegistry;
export { MetricsRegistry };
export type { AggregatedMetric };
//# sourceMappingURL=registry.d.ts.map