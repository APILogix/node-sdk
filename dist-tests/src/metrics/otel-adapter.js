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
import { MeterProvider, AggregationType, } from '@opentelemetry/sdk-metrics';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION, ATTR_DEPLOYMENT_ENVIRONMENT_NAME, } from '@opentelemetry/semantic-conventions';
import { metrics, context } from '@opentelemetry/api';
import { suppressTracing } from '@opentelemetry/core';
import { getLogger } from '../utils/logger.js';
import { LynkTraceMetricReader, PulseMetricReader } from './pulse-metric-reader.js';
import { SDK_NAME, SDK_VERSION } from '../constants/version.js';
import os from 'node:os';
const METER_PROVIDER_SYMBOL = Symbol.for('lynktrace.otel.meter-provider');
const METER_PROVIDER_SYMBOL_LEGACY = Symbol.for('pulse-sdk.otel.meter-provider');
// ─── Otel Metrics Manager — singleton lifecycle ─────────────────────────────
class OtelMetricsManager {
    provider = null;
    meter = null;
    reader = null;
    initialized = false;
    flushTimer = null;
    flushIntervalMs;
    histograms = new Map();
    counters = new Map();
    upDownCounters = new Map();
    gauges = new Map();
    ownsProvider = false;
    constructor(options = {}) {
        this.flushIntervalMs = options.flushIntervalMs ?? 10000;
    }
    /**
     * Initialize the OTel MeterProvider with exponential histogram aggregation.
     * Called during SDK init when `enableMetrics: true`.
     */
    init(config, options = {}, customResources) {
        if (this.initialized)
            return;
        const logger = getLogger();
        try {
            const globalState = globalThis;
            if (globalState[METER_PROVIDER_SYMBOL] || globalState[METER_PROVIDER_SYMBOL_LEGACY]) {
                this.meter = metrics.getMeter(SDK_NAME, SDK_VERSION);
                this.initialized = true;
                this.ownsProvider = false;
                logger.info('OpenTelemetry meter provider already registered by APM telemetry; reusing global provider');
                return;
            }
            const maxBuckets = options.maxHistogramBuckets ?? 160;
            const percentiles = options.percentiles ?? [50, 75, 90, 95, 99];
            const cardinalityLimit = options.cardinalityLimit ?? 2000;
            const resource = resourceFromAttributes({
                [ATTR_SERVICE_NAME]: config.service,
                [ATTR_SERVICE_VERSION]: config.release,
                [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: config.environment,
                'host.name': os.hostname(),
                'host.arch': os.arch(),
                'os.type': os.type(),
                'os.version': os.release(),
                'process.pid': process.pid,
                'process.runtime.name': 'node',
                'process.runtime.version': process.version,
                'telemetry.sdk.name': SDK_NAME,
                'telemetry.sdk.version': SDK_VERSION,
                'telemetry.sdk.language': 'nodejs',
                ...(customResources ?? {}),
            });
            this.reader = new LynkTraceMetricReader({ percentiles });
            const meterProviderOptions = {
                resource,
                readers: [this.reader],
                views: [
                    {
                        instrumentName: '*.duration',
                        aggregation: { type: AggregationType.EXPONENTIAL_HISTOGRAM, options: { maxSize: maxBuckets } },
                    },
                    {
                        instrumentName: '*.latency',
                        aggregation: { type: AggregationType.EXPONENTIAL_HISTOGRAM, options: { maxSize: maxBuckets } },
                    },
                    {
                        instrumentName: '*.time',
                        aggregation: { type: AggregationType.EXPONENTIAL_HISTOGRAM, options: { maxSize: maxBuckets } },
                    },
                    {
                        instrumentName: '*.size',
                        aggregation: { type: AggregationType.EXPONENTIAL_HISTOGRAM, options: { maxSize: maxBuckets } },
                    },
                ],
            };
            this.provider = new MeterProvider(meterProviderOptions);
            this.meter = this.provider.getMeter(SDK_NAME, SDK_VERSION);
            metrics.setGlobalMeterProvider(this.provider);
            globalState[METER_PROVIDER_SYMBOL] = true;
            globalState[METER_PROVIDER_SYMBOL_LEGACY] = true;
            this.ownsProvider = true;
            this.flushTimer = setInterval(() => {
                context.with(suppressTracing(context.active()), () => {
                    void this.flush();
                });
            }, this.flushIntervalMs);
            this.flushTimer.unref();
            this.initialized = true;
            logger.info('OpenTelemetry metrics initialized', {
                service: config.service,
                environment: config.environment,
                maxHistogramBuckets: maxBuckets,
                percentiles,
                cardinalityLimit,
            });
        }
        catch (err) {
            logger.error('Failed to initialize OpenTelemetry metrics', { error: err });
        }
    }
    /**
     * Record a histogram value using OTel exponential histogram.
     * O(1) per record — no raw value storage, no sorting.
     */
    recordHistogram(name, value, labels = {}, unit) {
        if (!this.initialized || !this.meter)
            return;
        try {
            let histogram = this.histograms.get(name);
            if (!histogram) {
                histogram = this.meter.createHistogram(name, {
                    description: `Histogram for ${name}`,
                    unit: unit || 'ms',
                });
                this.histograms.set(name, histogram);
            }
            histogram.record(value, labels);
        }
        catch (err) {
            getLogger().warn('Failed to record OTel histogram', { name, value, error: err });
        }
    }
    /**
     * Increment a counter using OTel.
     */
    incrementCounter(name, value, labels = {}, unit) {
        if (!this.initialized || !this.meter)
            return;
        try {
            let counter = this.counters.get(name);
            if (!counter) {
                counter = this.meter.createCounter(name, {
                    description: `Counter for ${name}`,
                    unit: unit || '1',
                });
                this.counters.set(name, counter);
            }
            counter.add(value, labels);
        }
        catch (err) {
            getLogger().warn('Failed to record OTel counter', { name, value, error: err });
        }
    }
    /**
     * Record an up-down counter value using OTel.
     */
    addUpDownCounter(name, value, labels = {}, unit) {
        if (!this.initialized || !this.meter)
            return;
        try {
            let upDownCounter = this.upDownCounters.get(name);
            if (!upDownCounter) {
                upDownCounter = this.meter.createUpDownCounter(name, {
                    description: `UpDownCounter for ${name}`,
                    unit: unit || '1',
                });
                this.upDownCounters.set(name, upDownCounter);
            }
            upDownCounter.add(value, labels);
        }
        catch (err) {
            getLogger().warn('Failed to record OTel upDownCounter', { name, value, error: err });
        }
    }
    /**
     * Set a gauge value using OTel.
     */
    setGauge(name, value, labels = {}, unit) {
        if (!this.initialized || !this.meter)
            return;
        try {
            let gauge = this.gauges.get(name);
            if (!gauge) {
                gauge = this.meter.createGauge(name, {
                    description: `Gauge for ${name}`,
                    unit: unit || '1',
                });
                this.gauges.set(name, gauge);
            }
            gauge.record(value, labels);
        }
        catch (err) {
            getLogger().warn('Failed to record OTel gauge', { name, value, error: err });
        }
    }
    /**
     * Force-flush all pending metrics through the event pipeline.
     */
    async flush(internalTelemetry = false) {
        if (!this.reader)
            return;
        try {
            await this.reader.collectAndExport(internalTelemetry);
        }
        catch (err) {
            getLogger().error('Failed to flush OTel metrics', { error: err });
        }
    }
    /**
     * Shut down the OTel metrics provider.
     */
    async shutdown() {
        const logger = getLogger();
        if (this.flushTimer) {
            clearInterval(this.flushTimer);
            this.flushTimer = null;
        }
        if (!this.provider) {
            logger.debug('OTel metrics shutdown skipped — not initialized');
            return;
        }
        try {
            if (this.ownsProvider) {
                await this.provider.shutdown();
                const g = globalThis;
                delete g[METER_PROVIDER_SYMBOL];
                delete g[METER_PROVIDER_SYMBOL_LEGACY];
            }
            this.initialized = false;
            this.provider = null;
            this.meter = null;
            this.reader = null;
            this.histograms.clear();
            this.counters.clear();
            this.upDownCounters.clear();
            this.gauges.clear();
            this.ownsProvider = false;
            logger.info('OpenTelemetry metrics shut down');
        }
        catch (err) {
            logger.error('Failed to shut down OpenTelemetry metrics', { error: err });
        }
    }
    getStats() {
        return {
            initialized: this.initialized,
            histogramCount: this.histograms.size,
            counterCount: this.counters.size,
            upDownCounterCount: this.upDownCounters.size,
            gaugeCount: this.gauges.size,
            readerStats: this.reader?.getStats(),
        };
    }
    isInitialized() {
        return this.initialized;
    }
}
// ─── Singleton ──────────────────────────────────────────────────────────────
export const otelMetrics = new OtelMetricsManager();
export { OtelMetricsManager };
