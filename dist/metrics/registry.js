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
import { getLogger } from '../utils/logger.js';
import { epochMs } from '../utils/time.js';
import { generateId } from '../utils/uuid.js';
import { captureEvent } from '../capture/captureEvent.js';
// ─── Histogram Aggregator ───────────────────────────────────────────────────
class HistogramAggregator {
    boundaries;
    maxCardinality;
    values = [];
    labelSets = new Map();
    count = 0;
    sum = 0;
    min = Infinity;
    max = -Infinity;
    constructor(options = {}) {
        this.boundaries = options.boundaries ?? [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000];
        this.maxCardinality = options.maxCardinality ?? 1000;
    }
    record(value, labels = {}) {
        const key = this.labelKey(labels);
        if (!this.labelSets.has(key)) {
            if (this.labelSets.size >= this.maxCardinality) {
                getLogger().warn('Metric cardinality limit reached', {
                    metric: 'histogram',
                    cardinality: this.labelSets.size,
                    maxCardinality: this.maxCardinality,
                });
                return;
            }
            this.labelSets.set(key, []);
        }
        const bucket = this.labelSets.get(key);
        bucket.push(value);
        this.values.push(value);
        this.count++;
        this.sum += value;
        if (value < this.min)
            this.min = value;
        if (value > this.max)
            this.max = value;
    }
    flush() {
        const results = [];
        const now = epochMs();
        // Global aggregation
        if (this.values.length > 0) {
            const sorted = [...this.values].sort((a, b) => a - b);
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
                p90: percentile(sorted, 90),
                p95: percentile(sorted, 95),
                p99: percentile(sorted, 99),
                avg: this.sum / this.count,
                rate: 0,
            });
        }
        // Per-label aggregation
        for (const [key, vals] of this.labelSets.entries()) {
            if (vals.length === 0)
                continue;
            const sorted = [...vals].sort((a, b) => a - b);
            const labels = this.parseLabelKey(key);
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
                p90: percentile(sorted, 90),
                p95: percentile(sorted, 95),
                p99: percentile(sorted, 99),
                avg: sorted.reduce((a, b) => a + b, 0) / sorted.length,
                rate: 0,
            });
        }
        this.reset();
        return results;
    }
    reset() {
        this.values = [];
        this.labelSets.clear();
        this.count = 0;
        this.sum = 0;
        this.min = Infinity;
        this.max = -Infinity;
    }
    labelKey(labels) {
        return Object.entries(labels)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => `${k}=${v}`)
            .join(',');
    }
    parseLabelKey(key) {
        if (!key)
            return {};
        const labels = {};
        for (const pair of key.split(',')) {
            const [k, ...rest] = pair.split('=');
            if (k)
                labels[k] = rest.join('=');
        }
        return labels;
    }
}
// ─── Windowed Counter ───────────────────────────────────────────────────────
class WindowedCounter {
    maxCardinality;
    windowMs;
    windows = new Map();
    labelSets = new Set();
    constructor(options = {}, windowMs = 10000) {
        this.maxCardinality = options.maxCardinality ?? 1000;
        this.windowMs = windowMs;
    }
    add(value, labels = {}) {
        const key = this.labelKey(labels);
        if (!this.labelSets.has(key)) {
            if (this.labelSets.size >= this.maxCardinality) {
                getLogger().warn('Metric cardinality limit reached', {
                    metric: 'counter',
                    cardinality: this.labelSets.size,
                    maxCardinality: this.maxCardinality,
                });
                return;
            }
            this.labelSets.add(key);
        }
        const now = epochMs();
        const window = this.windows.get(key);
        if (!window || now - window.start > this.windowMs) {
            this.windows.set(key, { value, start: now });
        }
        else {
            window.value += value;
        }
    }
    flush() {
        const results = [];
        const now = epochMs();
        for (const [key, window] of this.windows.entries()) {
            if (window.value === 0)
                continue;
            const labels = this.parseLabelKey(key);
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
                p90: window.value,
                p95: window.value,
                p99: window.value,
                avg: window.value,
                rate: window.value / (this.windowMs / 1000),
            });
        }
        this.windows.clear();
        return results;
    }
    labelKey(labels) {
        return Object.entries(labels)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => `${k}=${v}`)
            .join(',');
    }
    parseLabelKey(key) {
        if (!key)
            return {};
        const labels = {};
        for (const pair of key.split(',')) {
            const [k, ...rest] = pair.split('=');
            if (k)
                labels[k] = rest.join('=');
        }
        return labels;
    }
}
// ─── UpDownCounter ──────────────────────────────────────────────────────────
class UpDownCounter {
    maxCardinality;
    values = new Map();
    labelSets = new Set();
    constructor(options = {}) {
        this.maxCardinality = options.maxCardinality ?? 1000;
    }
    add(value, labels = {}) {
        const key = this.labelKey(labels);
        if (!this.labelSets.has(key)) {
            if (this.labelSets.size >= this.maxCardinality) {
                getLogger().warn('Metric cardinality limit reached', {
                    metric: 'updown_counter',
                    cardinality: this.labelSets.size,
                    maxCardinality: this.maxCardinality,
                });
                return;
            }
            this.labelSets.add(key);
        }
        const current = this.values.get(key) ?? 0;
        this.values.set(key, current + value);
    }
    set(value, labels = {}) {
        const key = this.labelKey(labels);
        if (!this.labelSets.has(key)) {
            if (this.labelSets.size >= this.maxCardinality) {
                getLogger().warn('Metric cardinality limit reached', {
                    metric: 'updown_counter',
                    cardinality: this.labelSets.size,
                    maxCardinality: this.maxCardinality,
                });
                return;
            }
            this.labelSets.add(key);
        }
        this.values.set(key, value);
    }
    flush() {
        const results = [];
        const now = epochMs();
        for (const [key, value] of this.values.entries()) {
            const labels = this.parseLabelKey(key);
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
                p90: value,
                p95: value,
                p99: value,
                avg: value,
                rate: 0,
            });
        }
        return results;
    }
    labelKey(labels) {
        return Object.entries(labels)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => `${k}=${v}`)
            .join(',');
    }
    parseLabelKey(key) {
        if (!key)
            return {};
        const labels = {};
        for (const pair of key.split(',')) {
            const [k, ...rest] = pair.split('=');
            if (k)
                labels[k] = rest.join('=');
        }
        return labels;
    }
}
// ─── Gauge ──────────────────────────────────────────────────────────────────
class GaugeAggregator {
    maxCardinality;
    values = new Map();
    labelSets = new Set();
    constructor(options = {}) {
        this.maxCardinality = options.maxCardinality ?? 1000;
    }
    set(value, labels = {}) {
        const key = this.labelKey(labels);
        if (!this.labelSets.has(key)) {
            if (this.labelSets.size >= this.maxCardinality) {
                getLogger().warn('Metric cardinality limit reached', {
                    metric: 'gauge',
                    cardinality: this.labelSets.size,
                    maxCardinality: this.maxCardinality,
                });
                return;
            }
            this.labelSets.add(key);
        }
        this.values.set(key, { value, timestamp: epochMs() });
    }
    flush() {
        const results = [];
        for (const [key, entry] of this.values.entries()) {
            const labels = this.parseLabelKey(key);
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
                p90: entry.value,
                p95: entry.value,
                p99: entry.value,
                avg: entry.value,
                rate: 0,
            });
        }
        return results;
    }
    labelKey(labels) {
        return Object.entries(labels)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => `${k}=${v}`)
            .join(',');
    }
    parseLabelKey(key) {
        if (!key)
            return {};
        const labels = {};
        for (const pair of key.split(',')) {
            const [k, ...rest] = pair.split('=');
            if (k)
                labels[k] = rest.join('=');
        }
        return labels;
    }
}
// ─── Metrics Registry ───────────────────────────────────────────────────────
class MetricsRegistry {
    histograms = new Map();
    counters = new Map();
    upDownCounters = new Map();
    gauges = new Map();
    flushTimer = null;
    flushIntervalMs;
    maxMetrics;
    defaultBoundaries;
    defaultMaxCardinality;
    initialized = false;
    totalFlushed = 0;
    totalDropped = 0;
    constructor(options = {}) {
        this.flushIntervalMs = options.flushIntervalMs ?? 10000;
        this.maxMetrics = options.maxMetrics ?? 500;
        this.defaultBoundaries = options.defaultHistogramBoundaries ?? [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000];
        this.defaultMaxCardinality = options.defaultMaxCardinality ?? 1000;
    }
    start() {
        if (this.initialized)
            return;
        this.initialized = true;
        this.flushTimer = setInterval(() => this.flush(), this.flushIntervalMs);
        this.flushTimer.unref();
    }
    stop() {
        if (this.flushTimer) {
            clearInterval(this.flushTimer);
            this.flushTimer = null;
        }
        this.initialized = false;
    }
    recordHistogram(name, value, options = {}) {
        if (!this.initialized)
            return;
        if (this.histograms.size >= this.maxMetrics && !this.histograms.has(name)) {
            this.totalDropped++;
            return;
        }
        let agg = this.histograms.get(name);
        if (!agg) {
            agg = new HistogramAggregator({
                boundaries: options.boundaries ?? this.defaultBoundaries,
                maxCardinality: options.maxCardinality ?? this.defaultMaxCardinality,
            });
            this.histograms.set(name, agg);
        }
        agg.record(value, options.labels ?? {});
    }
    incrementCounter(name, value = 1, options = {}) {
        if (!this.initialized)
            return;
        if (this.counters.size >= this.maxMetrics && !this.counters.has(name)) {
            this.totalDropped++;
            return;
        }
        let agg = this.counters.get(name);
        if (!agg) {
            agg = new WindowedCounter({ maxCardinality: options.maxCardinality ?? this.defaultMaxCardinality }, this.flushIntervalMs);
            this.counters.set(name, agg);
        }
        agg.add(value, options.labels ?? {});
    }
    addUpDownCounter(name, value, options = {}) {
        if (!this.initialized)
            return;
        if (this.upDownCounters.size >= this.maxMetrics && !this.upDownCounters.has(name)) {
            this.totalDropped++;
            return;
        }
        let agg = this.upDownCounters.get(name);
        if (!agg) {
            agg = new UpDownCounter({ maxCardinality: options.maxCardinality ?? this.defaultMaxCardinality });
            this.upDownCounters.set(name, agg);
        }
        agg.add(value, options.labels ?? {});
    }
    setGauge(name, value, options = {}) {
        if (!this.initialized)
            return;
        if (this.gauges.size >= this.maxMetrics && !this.gauges.has(name)) {
            this.totalDropped++;
            return;
        }
        let agg = this.gauges.get(name);
        if (!agg) {
            agg = new GaugeAggregator({ maxCardinality: options.maxCardinality ?? this.defaultMaxCardinality });
            this.gauges.set(name, agg);
        }
        agg.set(value, options.labels ?? {});
    }
    flush() {
        const aggregated = [];
        for (const [name, agg] of this.histograms.entries()) {
            const results = agg.flush();
            for (const r of results) {
                r.name = name;
                aggregated.push(r);
            }
        }
        for (const [name, agg] of this.counters.entries()) {
            const results = agg.flush();
            for (const r of results) {
                r.name = name;
                aggregated.push(r);
            }
        }
        for (const [name, agg] of this.upDownCounters.entries()) {
            const results = agg.flush();
            for (const r of results) {
                r.name = name;
                aggregated.push(r);
            }
        }
        for (const [name, agg] of this.gauges.entries()) {
            const results = agg.flush();
            for (const r of results) {
                r.name = name;
                aggregated.push(r);
            }
        }
        for (const metric of aggregated) {
            const event = {
                type: 'metric',
                eventId: generateId(),
                metricName: metric.name,
                metricType: metric.type,
                value: metric.value,
                timestamp: metric.timestamp,
                tags: metric.labels,
                count: metric.count,
                sum: metric.sum,
                min: metric.min,
                max: metric.max,
                p50: metric.p50,
                p90: metric.p90,
                p95: metric.p95,
                p99: metric.p99,
                avg: metric.avg,
                rate: metric.rate,
            };
            captureEvent(event);
            this.totalFlushed++;
        }
    }
    getStats() {
        return {
            initialized: this.initialized,
            histogramCount: this.histograms.size,
            counterCount: this.counters.size,
            upDownCounterCount: this.upDownCounters.size,
            gaugeCount: this.gauges.size,
            totalFlushed: this.totalFlushed,
            totalDropped: this.totalDropped,
        };
    }
    reset() {
        this.histograms.clear();
        this.counters.clear();
        this.upDownCounters.clear();
        this.gauges.clear();
        this.totalFlushed = 0;
        this.totalDropped = 0;
    }
}
// ─── Utilities ──────────────────────────────────────────────────────────────
function percentile(sorted, p) {
    if (sorted.length === 0)
        return 0;
    const index = Math.ceil((p / 100) * sorted.length) - 1;
    const safeIndex = Math.max(0, Math.min(index, sorted.length - 1));
    return sorted[safeIndex] ?? 0;
}
// ─── Singleton ──────────────────────────────────────────────────────────────
export const metricsRegistry = new MetricsRegistry();
export { MetricsRegistry };
//# sourceMappingURL=registry.js.map