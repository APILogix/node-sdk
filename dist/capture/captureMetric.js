/**
 * Metric capture — captures counter, gauge, and histogram metric events.
 *
 * Uses the enterprise metrics registry for client-side aggregation.
 * Falls back to raw event capture if registry is not initialized.
 */
import { captureEvent } from './captureEvent.js';
import { getLogger } from '../utils/logger.js';
import { epochMs } from '../utils/time.js';
import { metricsRegistry } from '../metrics/registry.js';
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
        if (metricsRegistry.getStats().initialized) {
            const labels = options?.tags ?? {};
            if (type === 'histogram') {
                metricsRegistry.recordHistogram(name, value, { labels });
                return;
            }
            if (type === 'counter') {
                metricsRegistry.incrementCounter(name, value, { labels });
                return;
            }
            if (type === 'gauge') {
                metricsRegistry.setGauge(name, value, { labels });
                return;
            }
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
// ─── Convenience Methods ────────────────────────────────────────────────────
/** Increment a counter metric by the given value (default: 1). */
export function incrementCounter(name, value = 1, tags) {
    if (metricsRegistry.getStats().initialized) {
        metricsRegistry.incrementCounter(name, value, { labels: tags ?? {} });
        return;
    }
    captureMetric(name, value, 'counter', tags ? { tags } : undefined);
}
/** Set a gauge metric to the given value. */
export function setGauge(name, value, tags) {
    if (metricsRegistry.getStats().initialized) {
        metricsRegistry.setGauge(name, value, { labels: tags ?? {} });
        return;
    }
    captureMetric(name, value, 'gauge', tags ? { tags } : undefined);
}
/** Record a histogram value (e.g., latency, size). */
export function recordHistogram(name, value, tags, unit) {
    if (metricsRegistry.getStats().initialized) {
        metricsRegistry.recordHistogram(name, value, { labels: tags ?? {} });
        return;
    }
    const opts = {};
    if (tags)
        opts.tags = tags;
    if (unit)
        opts.unit = unit;
    captureMetric(name, value, 'histogram', Object.keys(opts).length > 0 ? opts : undefined);
}
/**
 * Add to an up-down counter (can go negative).
 * Used for tracking active connections, queue depth, etc.
 */
export function addUpDownCounter(name, value, tags) {
    if (metricsRegistry.getStats().initialized) {
        metricsRegistry.addUpDownCounter(name, value, { labels: tags ?? {} });
        return;
    }
    captureMetric(name, value, 'gauge', tags ? { tags } : undefined);
}
//# sourceMappingURL=captureMetric.js.map