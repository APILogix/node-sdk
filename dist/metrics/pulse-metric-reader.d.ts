/**
 * Pulse Metric Reader — custom MetricReader that exports OTel metrics
 * through the SDK's event processing pipeline.
 *
 * Separated from otel-adapter.ts for clean separation of concerns:
 * - This module: metric reading, transformation, export formatting
 * - otel-adapter.ts: OTel MeterProvider lifecycle, SDK compatibility wrappers
 */
import { MetricReader } from '@opentelemetry/sdk-metrics';
export interface AggregatedHistogramPoint {
    name: string;
    metricType: string;
    labels: Record<string, string>;
    timestamp: number;
    count: number;
    sum: number;
    min: number;
    max: number;
    avg: number;
    buckets?: {
        scale: number;
        offset: number;
        positiveCounts: number[];
        negativeCounts?: number[];
        zeroCount: number;
    } | undefined;
}
/**
 * Custom MetricReader that collects metrics from the OTel MeterProvider
 * and routes them through the SDK's event processing pipeline.
 *
 * This ensures metrics get the same sanitization, plugin processing,
 * and transport resilience as all other SDK events.
 */
export declare class PulseMetricReader extends MetricReader {
    private totalCollected;
    private totalDropped;
    constructor(options?: {
        percentiles?: number[];
    });
    protected onForceFlush(): Promise<void>;
    protected onShutdown(): Promise<void>;
    /**
     * Collect metrics from the SDK and export through the event pipeline.
     */
    collectAndExport(): Promise<void>;
    private processMetricData;
    private dataPointToEvent;
    getStats(): {
        totalCollected: number;
        totalDropped: number;
    };
}
export declare function extractLabels(attributes: Record<string, unknown> | undefined): Record<string, string>;
//# sourceMappingURL=pulse-metric-reader.d.ts.map