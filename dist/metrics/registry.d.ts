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
import { cardinalityGovernor } from '../utils/cardinality-governor.js';
export interface MetricLabels {
    [key: string]: string;
}
export interface MetricOptions {
    labels?: MetricLabels;
    timestamp?: number;
}
export interface HistogramOptions {
    /** Bucket boundaries (ignored in OTel mode — exponential buckets used). */
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
    /** Default histogram boundaries (ignored in OTel mode). */
    defaultHistogramBoundaries?: number[];
    /** Default max cardinality per metric. Default: 1000 */
    defaultMaxCardinality?: number;
}
export interface AggregatedMetric {
    name: string;
    type: string;
    labels: MetricLabels;
    timestamp: number;
    value: number;
    count: number;
    sum: number;
    min: number;
    max: number;
    avg: number;
    rate: number;
}
declare class MetricsRegistry {
    private readonly maxMetrics;
    private readonly defaultMaxCardinality;
    private initialized;
    private totalFlushed;
    private totalDropped;
    private registeredMetrics;
    constructor(options?: MetricRegistryOptions);
    start(): void;
    stop(): void;
    /**
     * Record a histogram value.
     * Delegates to OTel ExponentialHistogram — O(1) per record.
     * Backend computes percentiles from raw bucket data.
     */
    recordHistogram(name: string, value: number, options?: MetricOptions & HistogramOptions): void;
    incrementCounter(name: string, value?: number, options?: MetricOptions & CounterOptions): void;
    addUpDownCounter(name: string, value: number, options?: MetricOptions & CounterOptions): void;
    setGauge(name: string, value: number, options?: MetricOptions & CounterOptions): void;
    /**
     * Flush pending metrics through the OTel reader → event pipeline.
     *
     * Returns a Promise so callers (especially shutdown) can `await`
     * the actual completion. The previous void return + floated
     * `.catch(() => {})` chain made shutdown-time metrics best-effort
     * even on graceful exit, since the lifecycle moved on before the
     * OTel reader had finished collecting and emitting.
     */
    flush(internalTelemetry?: boolean): Promise<void>;
    getStats(): {
        initialized: boolean;
        registeredMetrics: number;
        totalFlushed: number;
        totalDropped: number;
        cardinalityStats: ReturnType<typeof cardinalityGovernor.getStats>;
        otelStats?: {
            histogramCount: number;
            counterCount: number;
            upDownCounterCount: number;
            gaugeCount: number;
        } | undefined;
    };
    reset(): void;
    private canRegisterMetric;
}
/**
 * Serializes metric labels into a canonical key.
 * Fast, allocation-conscious implementation eliminating JSON.stringify,
 * localeCompare, and intermediate arrays on hot recording paths (SEC-06).
 */
export declare function serializeLabels(labels: Record<string, string>): string;
export declare const metricsRegistry: MetricsRegistry;
export { MetricsRegistry };
export type { AggregatedMetric as AggregatedMetricLegacy };
