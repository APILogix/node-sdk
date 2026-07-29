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
 *   MetricsRegistry → OtelMetricsManager → MeterProvider → ExponentialHistogramAggregation → PulseMetricReader → EventPipeline
 */
import { getLogger } from '../utils/logger.js';
import { otelMetrics } from './otel-adapter.js';
import { cardinalityGovernor } from '../utils/cardinality-governor.js';
// ─── Metrics Registry (OTel-native wrapper) ─────────────────────────────────
class MetricsRegistry {
    maxMetrics;
    defaultMaxCardinality;
    initialized = false;
    totalFlushed = 0;
    totalDropped = 0;
    registeredMetrics = new Set();
    constructor(options = {}) {
        this.maxMetrics = options.maxMetrics ?? 500;
        this.defaultMaxCardinality = options.defaultMaxCardinality ?? 1000;
    }
    start() {
        if (this.initialized)
            return;
        this.initialized = true;
    }
    stop() {
        this.initialized = false;
    }
    /**
     * Record a histogram value.
     * Delegates to OTel ExponentialHistogram — O(1) per record.
     * Backend computes percentiles from raw bucket data.
     */
    recordHistogram(name, value, options = {}) {
        if (!this.initialized)
            return;
        if (!this.canRegisterMetric(name)) {
            this.totalDropped++;
            return;
        }
        const labels = options.labels ?? {};
        const sanitized = cardinalityGovernor.sanitizeAttributes(name, labels);
        const seriesKey = serializeLabels(sanitized);
        if (!cardinalityGovernor.canRecordSeries(name, seriesKey)) {
            this.totalDropped++;
            return;
        }
        if (otelMetrics.isInitialized()) {
            otelMetrics.recordHistogram(name, value, sanitized);
            this.totalFlushed++;
        }
        else {
            getLogger().debug('Histogram recorded but OTel metrics not initialized', { name });
        }
    }
    incrementCounter(name, value = 1, options = {}) {
        if (!this.initialized)
            return;
        if (!this.canRegisterMetric(name)) {
            this.totalDropped++;
            return;
        }
        const labels = options.labels ?? {};
        const sanitized = cardinalityGovernor.sanitizeAttributes(name, labels);
        const seriesKey = serializeLabels(sanitized);
        if (!cardinalityGovernor.canRecordSeries(name, seriesKey)) {
            this.totalDropped++;
            return;
        }
        if (otelMetrics.isInitialized()) {
            otelMetrics.incrementCounter(name, value, sanitized);
            this.totalFlushed++;
        }
    }
    addUpDownCounter(name, value, options = {}) {
        if (!this.initialized)
            return;
        if (!this.canRegisterMetric(name)) {
            this.totalDropped++;
            return;
        }
        const labels = options.labels ?? {};
        const sanitized = cardinalityGovernor.sanitizeAttributes(name, labels);
        const seriesKey = serializeLabels(sanitized);
        if (!cardinalityGovernor.canRecordSeries(name, seriesKey)) {
            this.totalDropped++;
            return;
        }
        if (otelMetrics.isInitialized()) {
            otelMetrics.addUpDownCounter(name, value, sanitized);
            this.totalFlushed++;
        }
    }
    setGauge(name, value, options = {}) {
        if (!this.initialized)
            return;
        if (!this.canRegisterMetric(name)) {
            this.totalDropped++;
            return;
        }
        const labels = options.labels ?? {};
        const sanitized = cardinalityGovernor.sanitizeAttributes(name, labels);
        const seriesKey = serializeLabels(sanitized);
        if (!cardinalityGovernor.canRecordSeries(name, seriesKey)) {
            this.totalDropped++;
            return;
        }
        if (otelMetrics.isInitialized()) {
            otelMetrics.setGauge(name, value, sanitized);
            this.totalFlushed++;
        }
    }
    /**
     * Flush pending metrics through the OTel reader → event pipeline.
     *
     * Returns a Promise so callers (especially shutdown) can `await`
     * the actual completion. The previous void return + floated
     * `.catch(() => {})` chain made shutdown-time metrics best-effort
     * even on graceful exit, since the lifecycle moved on before the
     * OTel reader had finished collecting and emitting.
     */
    async flush(internalTelemetry = false) {
        if (otelMetrics.isInitialized()) {
            try {
                await otelMetrics.flush(internalTelemetry);
            }
            catch {
                // Best-effort: the next normal flush cycle will retry.
            }
        }
    }
    getStats() {
        const otelStats = otelMetrics.getStats();
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
        };
    }
    reset() {
        this.registeredMetrics.clear();
        this.totalFlushed = 0;
        this.totalDropped = 0;
        cardinalityGovernor.reset();
    }
    // ─── Internal ───────────────────────────────────────────────────────────
    canRegisterMetric(name) {
        if (this.registeredMetrics.has(name))
            return true;
        if (this.registeredMetrics.size >= this.maxMetrics)
            return false;
        this.registeredMetrics.add(name);
        return true;
    }
}
// ─── Utilities ──────────────────────────────────────────────────────────────
const LABEL_CACHE_SIZE = 1000;
const labelCache = new Map();
function serializeLabels(labels) {
    const entries = Object.entries(labels);
    if (entries.length === 0)
        return '';
    // Fast path: if the labels were already sanitized in the same order, we
    // can reuse the canonical string. The key is the sorted JSON of the labels.
    const sorted = entries.sort(([a], [b]) => a.localeCompare(b));
    const cacheKey = JSON.stringify(sorted);
    const cached = labelCache.get(cacheKey);
    if (cached !== undefined)
        return cached;
    const serialized = sorted.map(([k, v]) => `${k}=${v}`).join(',');
    if (labelCache.size >= LABEL_CACHE_SIZE) {
        const oldest = labelCache.keys().next().value;
        if (oldest !== undefined)
            labelCache.delete(oldest);
    }
    labelCache.set(cacheKey, serialized);
    return serialized;
}
// ─── Singleton ──────────────────────────────────────────────────────────────
export const metricsRegistry = new MetricsRegistry();
export { MetricsRegistry };
//# sourceMappingURL=registry.js.map