/**
 * Metric capture — captures counter, gauge, and histogram metric events.
 */
import type { MetricType } from '../types/event.js';
/**
 * Capture a metric sample.
 *
 * @param name - Metric name (e.g. 'http.request.duration')
 * @param value - Numeric value
 * @param type - Metric type: 'counter', 'gauge', or 'histogram'
 * @param options - Optional tags and unit
 */
export declare function captureMetric(name: string, value: number, type?: MetricType, options?: {
    tags?: Record<string, string>;
    unit?: string;
}): void;
/** Increment a counter metric by the given value (default: 1). */
export declare function incrementCounter(name: string, value?: number, tags?: Record<string, string>): void;
/** Set a gauge metric to the given value. */
export declare function setGauge(name: string, value: number, tags?: Record<string, string>): void;
/** Record a histogram value (e.g., latency, size). */
export declare function recordHistogram(name: string, value: number, tags?: Record<string, string>, unit?: string): void;
//# sourceMappingURL=captureMetric.d.ts.map