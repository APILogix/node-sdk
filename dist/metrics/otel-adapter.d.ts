/**
 * Pulse SDK OpenTelemetry Metrics Adapter — enterprise-grade histogram
 * aggregation using OTel SDK Metrics with exponential histograms.
 *
 * Provides:
 * - ExponentialHistogram for high-precision latency percentiles (p50/p75/p90/p95/p99)
 * - O(1) per record — no raw value storage, no sorting on flush
 * - Custom MetricReader that exports through the SDK event pipeline
 * - Metric Views for aggregation configuration and cardinality control
 * - Seamless integration with existing MetricsRegistry API
 *
 * Architecture:
 *   MeterProvider → ExponentialHistogramAggregation → PulseMetricReader → EventPipeline
 *
 * Why OTel for histograms:
 *   - Custom implementation stores ALL raw values and sorts O(n log n) on flush
 *   - OTel exponential histograms use O(1) bucket increments, mergeable, precise
 *   - Sub-microsecond recording overhead vs milliseconds for sort-based percentiles
 */
import type { ResourceAttributes } from '../utils/resource-detector.js';
export interface OtelMetricsConfig {
    /** Flush interval in milliseconds. Default: 10000 (10s) */
    flushIntervalMs?: number;
    /** Max bucket size for exponential histogram. Default: 160 */
    maxHistogramBuckets?: number;
    /** Percentiles to compute on export. Default: [50, 75, 90, 95, 99] */
    percentiles?: number[];
    /** Cardinality limit per instrument. Default: 2000 */
    cardinalityLimit?: number;
}
declare class OtelMetricsManager {
    private provider;
    private meter;
    private reader;
    private initialized;
    private flushTimer;
    private flushIntervalMs;
    private histograms;
    private counters;
    private upDownCounters;
    private gauges;
    private ownsProvider;
    constructor(options?: OtelMetricsConfig);
    /**
     * Initialize the OTel MeterProvider with exponential histogram aggregation.
     * Called during SDK init when `enableMetrics: true`.
     */
    init(config: {
        service: string;
        environment: string;
        release: string;
    }, options?: OtelMetricsConfig, customResources?: ResourceAttributes): void;
    /**
     * Record a histogram value using OTel exponential histogram.
     * O(1) per record — no raw value storage, no sorting.
     */
    recordHistogram(name: string, value: number, labels?: Record<string, string>): void;
    /**
     * Increment a counter using OTel.
     */
    incrementCounter(name: string, value: number, labels?: Record<string, string>): void;
    /**
     * Record an up-down counter value using OTel.
     */
    addUpDownCounter(name: string, value: number, labels?: Record<string, string>): void;
    /**
     * Set a gauge value using OTel.
     */
    setGauge(name: string, value: number, labels?: Record<string, string>): void;
    /**
     * Force-flush all pending metrics through the event pipeline.
     */
    flush(): Promise<void>;
    /**
     * Shut down the OTel metrics provider.
     */
    shutdown(): Promise<void>;
    getStats(): {
        initialized: boolean;
        histogramCount: number;
        counterCount: number;
        upDownCounterCount: number;
        gaugeCount: number;
        readerStats?: {
            totalCollected: number;
            totalDropped: number;
        } | undefined;
    };
    isInitialized(): boolean;
}
export declare const otelMetrics: OtelMetricsManager;
export { OtelMetricsManager };
//# sourceMappingURL=otel-adapter.d.ts.map