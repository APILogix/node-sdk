/**
 * Enterprise Metrics Registry — client-side aggregation for production-scale telemetry.
 *
 * Provides:
 * - Windowed Counter aggregation (sum over configurable intervals)
 * - Histogram with client-side percentile computation (p50, p90, p95, p99, max)
 * - Gauge (last-value, point-in-time)
 * - UpDownCounter (monotonic up/down tracking)
 * - Summary (count + sum over time windows)
 * - Cardinality protection per metric
 * - Automatic flush on interval
 * - Memory-safe bounded storage
 *
 * Architecture follows OpenTelemetry Metrics SDK patterns:
 *   MetricReader → Aggregator → Export via SDK event pipeline
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
    /** Bucket boundaries for histogram. Default: [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000] */
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
    p90: number;
    p95: number;
    p99: number;
    avg: number;
    rate: number;
}
declare class MetricsRegistry {
    private histograms;
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
    };
    reset(): void;
}
export declare const metricsRegistry: MetricsRegistry;
export { MetricsRegistry };
export type { AggregatedMetric };
//# sourceMappingURL=registry.d.ts.map