/**
 * Metric capture — captures counter, gauge, and histogram metric events.
 *
 * Histograms use OpenTelemetry exponential histograms for O(1) recording
 * and high-precision percentile computation.
 * Counters/gauges use the enterprise metrics registry for aggregation.
 */
import { captureEvent } from './captureEvent.js';
import { getLogger } from '../utils/logger.js';
import { epochMs } from '../utils/time.js';
import { metricsRegistry } from '../metrics/registry.js';
import { KillswitchEngine } from '../core/killswitch-engine.js';
import { EntitlementGate } from '../core/entitlement-gate.js';
/**
 * Capture a metric sample.
 *
 * @param name - Metric name (e.g. 'http.request.duration')
 * @param value - Numeric value
 * @param type - Metric type: 'counter', 'gauge', or 'histogram'
 * @param options - Optional tags and unit
 */
export function captureMetric(name, value, type = 'gauge', options) {
    const logger = getLogger();
    try {
        if (!admitMetric(name, options?.tags))
            return;
        const labels = options?.tags ?? {};
        const unit = options?.unit;
        if (type === 'histogram') {
            metricsRegistry.recordHistogram(name, value, { labels, unit });
            return;
        }
        if (type === 'counter') {
            metricsRegistry.incrementCounter(name, value, { labels, unit });
            return;
        }
        if (type === 'gauge') {
            metricsRegistry.setGauge(name, value, { labels, unit });
            return;
        }
        const event = {
            type: 'metric',
            metricName: name,
            metricType: type,
            value,
            unit: options?.unit,
            tags: options?.tags,
            timestamp: epochMs(),
        };
        captureEvent(event);
    }
    catch (err) {
        logger.error('captureMetric failed', { error: err, metricName: name });
    }
}
function admitMetric(_name, _tags) {
    if (!EntitlementGate.isAllowed('customMetrics'))
        return false;
    return !KillswitchEngine.getInstance()?.isKilled('disableMetrics');
}
// ─── Convenience Methods ────────────────────────────────────────────────────
/** Increment a counter metric by the given value (default: 1). */
export function incrementCounter(name, value = 1, tags, unit) {
    if (!admitMetric(name, tags))
        return;
    metricsRegistry.incrementCounter(name, value, { labels: tags ?? {}, unit });
}
/** Set a gauge metric to the given value. */
export function setGauge(name, value, tags, unit) {
    if (!admitMetric(name, tags))
        return;
    metricsRegistry.setGauge(name, value, { labels: tags ?? {}, unit });
}
/** Record a histogram value (e.g., latency, size) using OTel exponential histogram. */
export function recordHistogram(name, value, tags, unit) {
    if (!admitMetric(name, tags))
        return;
    metricsRegistry.recordHistogram(name, value, { labels: tags ?? {}, unit });
}
/**
 * Add to an up-down counter (can go negative).
 * Used for tracking active connections, queue depth, etc.
 */
export function addUpDownCounter(name, value, tags, unit) {
    if (!admitMetric(name, tags))
        return;
    metricsRegistry.addUpDownCounter(name, value, { labels: tags ?? {}, unit });
}
