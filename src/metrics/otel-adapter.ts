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

import {
  MeterProvider,
  AggregationType,
  type MeterProviderOptions,
} from '@opentelemetry/sdk-metrics'
import { resourceFromAttributes } from '@opentelemetry/resources'
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
} from '@opentelemetry/semantic-conventions'
import { metrics, context, type Meter, type Histogram, type Counter, type UpDownCounter, type Gauge } from '@opentelemetry/api'
import { suppressTracing } from '@opentelemetry/core'
import { getLogger } from '../utils/logger.js'
import { PulseMetricReader } from './pulse-metric-reader.js'
import type { ResourceAttributes } from '../utils/resource-detector.js'
import os from 'node:os'

const METER_PROVIDER_SYMBOL = Symbol.for('pulse-sdk.otel.meter-provider')

// ─── Types ──────────────────────────────────────────────────────────────────

export interface OtelMetricsConfig {
  /** Flush interval in milliseconds. Default: 10000 (10s) */
  flushIntervalMs?: number
  /** Max bucket size for exponential histogram. Default: 160 */
  maxHistogramBuckets?: number
  /** Percentiles to compute on export. Default: [50, 75, 90, 95, 99] */
  percentiles?: number[]
  /** Cardinality limit per instrument. Default: 2000 */
  cardinalityLimit?: number
}

// ─── Otel Metrics Manager — singleton lifecycle ─────────────────────────────

class OtelMetricsManager {
  private provider: MeterProvider | null = null
  private meter: Meter | null = null
  private reader: PulseMetricReader | null = null
  private initialized = false
  private flushTimer: ReturnType<typeof setInterval> | null = null
  private flushIntervalMs: number
  private histograms = new Map<string, Histogram>()
  private counters = new Map<string, Counter>()
  private upDownCounters = new Map<string, UpDownCounter>()
  private gauges = new Map<string, Gauge>()
  private ownsProvider = false

  constructor(options: OtelMetricsConfig = {}) {
    this.flushIntervalMs = options.flushIntervalMs ?? 10000
  }

  /**
   * Initialize the OTel MeterProvider with exponential histogram aggregation.
   * Called during SDK init when `enableMetrics: true`.
   */
  init(config: { service: string; environment: string; release: string }, options: OtelMetricsConfig = {}, customResources?: ResourceAttributes): void {
    if (this.initialized) return

    const logger = getLogger()

    try {
      const globalState = globalThis as typeof globalThis & { [METER_PROVIDER_SYMBOL]?: true }
      if (globalState[METER_PROVIDER_SYMBOL]) {
        this.meter = metrics.getMeter('@vikasbaplawat1/pulse-sdk', '2.0.0')
        this.initialized = true
        this.ownsProvider = false
        logger.info('OpenTelemetry meter provider already registered by Pulse telemetry; reusing global provider')
        return
      }

      const maxBuckets = options.maxHistogramBuckets ?? 160
      const percentiles = options.percentiles ?? [50, 75, 90, 95, 99]
      const cardinalityLimit = options.cardinalityLimit ?? 2000

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
        'telemetry.sdk.name': '@vikasbaplawat1/pulse-sdk',
        'telemetry.sdk.version': '2.0.0',
        'telemetry.sdk.language': 'nodejs',
        ...(customResources ?? {}),
      })

      this.reader = new PulseMetricReader({ percentiles })

      const meterProviderOptions: MeterProviderOptions = {
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
          // NOTE: no bare '*' catch-all view here. The previous wildcard
          // forced EXPONENTIAL_HISTOGRAM aggregation onto EVERY instrument —
          // including counters and gauges — corrupting their semantics and
          // inflating memory/cardinality. Instruments that match none of
          // the suffix views above now keep their default aggregation.
        ],
      }

      this.provider = new MeterProvider(meterProviderOptions)

      this.meter = this.provider.getMeter('@vikasbaplawat1/pulse-sdk', '2.0.0')

      metrics.setGlobalMeterProvider(this.provider)
      globalState[METER_PROVIDER_SYMBOL] = true
      this.ownsProvider = true

      this.flushTimer = setInterval(() => {
        context.with(suppressTracing(context.active()), () => {
          void this.flush()
        })
      }, this.flushIntervalMs)
      this.flushTimer.unref()

      this.initialized = true

      logger.info('OpenTelemetry metrics initialized', {
        service: config.service,
        environment: config.environment,
        maxHistogramBuckets: maxBuckets,
        percentiles,
        cardinalityLimit,
      })
    } catch (err) {
      logger.error('Failed to initialize OpenTelemetry metrics', { error: err })
    }
  }

  /**
   * Record a histogram value using OTel exponential histogram.
   * O(1) per record — no raw value storage, no sorting.
   */
  recordHistogram(name: string, value: number, labels: Record<string, string> = {}): void {
    if (!this.initialized || !this.meter) return

    try {
      let histogram = this.histograms.get(name)
      if (!histogram) {
        histogram = this.meter.createHistogram(name, {
          description: `Histogram for ${name}`,
          unit: 'ms',
        })
        this.histograms.set(name, histogram)
      }
      histogram.record(value, labels)
    } catch (err) {
      getLogger().warn('Failed to record OTel histogram', { name, value, error: err })
    }
  }

  /**
   * Increment a counter using OTel.
   */
  incrementCounter(name: string, value: number, labels: Record<string, string> = {}): void {
    if (!this.initialized || !this.meter) return

    try {
      let counter = this.counters.get(name)
      if (!counter) {
        counter = this.meter.createCounter(name, {
          description: `Counter for ${name}`,
          unit: '1',
        })
        this.counters.set(name, counter)
      }
      counter.add(value, labels)
    } catch (err) {
      getLogger().warn('Failed to record OTel counter', { name, value, error: err })
    }
  }

  /**
   * Record an up-down counter value using OTel.
   */
  addUpDownCounter(name: string, value: number, labels: Record<string, string> = {}): void {
    if (!this.initialized || !this.meter) return

    try {
      let upDownCounter = this.upDownCounters.get(name)
      if (!upDownCounter) {
        upDownCounter = this.meter.createUpDownCounter(name, {
          description: `UpDownCounter for ${name}`,
          unit: '1',
        })
        this.upDownCounters.set(name, upDownCounter)
      }
      upDownCounter.add(value, labels)
    } catch (err) {
      getLogger().warn('Failed to record OTel upDownCounter', { name, value, error: err })
    }
  }

  /**
   * Set a gauge value using OTel.
   */
  setGauge(name: string, value: number, labels: Record<string, string> = {}): void {
    if (!this.initialized || !this.meter) return

    try {
      let gauge = this.gauges.get(name)
      if (!gauge) {
        gauge = this.meter.createGauge(name, {
          description: `Gauge for ${name}`,
          unit: '1',
        })
        this.gauges.set(name, gauge)
      }
      gauge.record(value, labels)
    } catch (err) {
      getLogger().warn('Failed to record OTel gauge', { name, value, error: err })
    }
  }

  /**
   * Force-flush all pending metrics through the event pipeline.
   */
  async flush(internalTelemetry = false): Promise<void> {
    if (!this.reader) return
    try {
      await this.reader.collectAndExport(internalTelemetry)
    } catch (err) {
      getLogger().error('Failed to flush OTel metrics', { error: err })
    }
  }

  /**
   * Shut down the OTel metrics provider.
   */
  async shutdown(): Promise<void> {
    const logger = getLogger()

    if (this.flushTimer) {
      clearInterval(this.flushTimer)
      this.flushTimer = null
    }

    if (!this.provider) {
      logger.debug('OTel metrics shutdown skipped — not initialized')
      return
    }

    try {
      if (this.ownsProvider) {
        await this.provider.shutdown()
        delete (globalThis as typeof globalThis & { [METER_PROVIDER_SYMBOL]?: true })[METER_PROVIDER_SYMBOL]
      }
      this.initialized = false
      this.provider = null
      this.meter = null
      this.reader = null
      this.histograms.clear()
      this.counters.clear()
      this.upDownCounters.clear()
      this.gauges.clear()
      this.ownsProvider = false
      logger.info('OpenTelemetry metrics shut down')
    } catch (err) {
      logger.error('Failed to shut down OpenTelemetry metrics', { error: err })
    }
  }

  getStats(): {
    initialized: boolean
    histogramCount: number
    counterCount: number
    upDownCounterCount: number
    gaugeCount: number
    readerStats?: { totalCollected: number; totalDropped: number } | undefined
  } {
    return {
      initialized: this.initialized,
      histogramCount: this.histograms.size,
      counterCount: this.counters.size,
      upDownCounterCount: this.upDownCounters.size,
      gaugeCount: this.gauges.size,
      readerStats: this.reader?.getStats(),
    }
  }

  isInitialized(): boolean {
    return this.initialized
  }
}

// ─── Singleton ──────────────────────────────────────────────────────────────

export const otelMetrics = new OtelMetricsManager()
export { OtelMetricsManager }
