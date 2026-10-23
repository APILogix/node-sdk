/**
 * Pulse Metric Reader — custom MetricReader that exports OTel metrics
 * through the SDK's event processing pipeline.
 *
 * Separated from otel-adapter.ts for clean separation of concerns:
 * - This module: metric reading, transformation, export formatting
 * - otel-adapter.ts: OTel MeterProvider lifecycle, SDK compatibility wrappers
 */

import {
  MetricReader,
  AggregationTemporality,
  DataPointType,
  type MetricData,
} from '@opentelemetry/sdk-metrics'
import { processEvent } from '../core/event-pipeline.js'
import { getLogger } from '../utils/logger.js'
import { epochMs } from '../utils/time.js'
import { generateId } from '../utils/uuid.js'
import type { MetricEvent, MetricType } from '../types/event.js'

// ─── Types ──────────────────────────────────────────────────────────────────

export interface AggregatedHistogramPoint {
  name: string
  metricType: string
  unit?: string | undefined
  labels: Record<string, string>
  timestamp: number
  count: number
  sum: number
  min: number
  max: number
  avg: number
  buckets?: {
    scale: number
    offset: number
    positiveCounts: number[]
    negativeCounts?: number[]
    zeroCount: number
  } | undefined
}

// ─── Pulse Metric Reader ────────────────────────────────────────────────────

/**
 * Custom MetricReader that collects metrics from the OTel MeterProvider
 * and routes them through the SDK's event processing pipeline.
 *
 * This ensures metrics get the same sanitization, plugin processing,
 * and transport resilience as all other SDK events.
 */
export class LynkTraceMetricReader extends MetricReader {
  private totalCollected = 0
  private totalDropped = 0

  constructor(options: { percentiles?: number[] } = {}) {
    super({
      aggregationTemporalitySelector: () => AggregationTemporality.DELTA,
    })
    void options
  }

  protected async onForceFlush(): Promise<void> {
    await this.collectAndExport()
  }

  protected async onShutdown(): Promise<void> {
    await this.collectAndExport()
  }

  /**
   * Collect metrics from the SDK and export through the event pipeline.
   */
  async collectAndExport(internalTelemetry = false): Promise<void> {
    try {
      const result = await this.collect()
      if (!result) return

      const logger = getLogger()
      let exportedCount = 0

      for (const scopeMetrics of result.resourceMetrics.scopeMetrics) {
        for (const metric of scopeMetrics.metrics) {
          const dataPoints = this.processMetricData(metric)
          for (const dp of dataPoints) {
            const event = this.dataPointToEvent(dp)
            if (event) {
              processEvent(internalTelemetry ? { ...event, __lynktraceInternal: true, __pulseInternal: true } : event)
              exportedCount++
            }
          }
        }
      }

      this.totalCollected += exportedCount
      logger.debug('OTel metrics exported', {
        count: exportedCount,
        totalCollected: this.totalCollected,
      })
    } catch (err) {
      getLogger().error('OTel metric collection failed', { error: err })
    }
  }

  private processMetricData(metricData: MetricData): AggregatedHistogramPoint[] {
    const points: AggregatedHistogramPoint[] = []
    const unit = metricData.descriptor.unit

    if (metricData.dataPointType === DataPointType.EXPONENTIAL_HISTOGRAM) {
      for (const dataPoint of metricData.dataPoints) {
        const value = dataPoint.value
        if (!value) continue

        const labels = extractLabels(dataPoint.attributes)

        // Extract exponential histogram bucket data for backend percentile computation
        const expValue = value as unknown as Record<string, unknown>
        const positive = expValue['positive'] as { offset?: number; bucketCounts?: number[] } | undefined
        const negative = expValue['negative'] as { offset?: number; bucketCounts?: number[] } | undefined
        const negativeCounts = negative?.bucketCounts

        const buckets: NonNullable<AggregatedHistogramPoint['buckets']> = {
            scale: (expValue['scale'] as number | undefined) ?? 0,
            offset: positive?.offset ?? 0,
            positiveCounts: positive?.bucketCounts ?? [],
            zeroCount: (expValue['zeroCount'] as number | undefined) ?? 0,
        }
        if (negativeCounts) {
            buckets.negativeCounts = negativeCounts
        }

        points.push({
          name: metricData.descriptor.name,
          metricType: 'histogram',
          unit,
          labels,
          timestamp: epochMs(),
          count: value.count ?? 0,
          sum: value.sum ?? 0,
          min: value.min ?? 0,
          max: value.max ?? 0,
          avg: value.count ? (value.sum ?? 0) / value.count : 0,
          buckets,
        })
      }
    }

    if (metricData.dataPointType === DataPointType.HISTOGRAM) {
      for (const dataPoint of metricData.dataPoints) {
        const value = dataPoint.value
        if (!value) continue

        const labels = extractLabels(dataPoint.attributes)

        points.push({
          name: metricData.descriptor.name,
          metricType: 'histogram',
          unit,
          labels,
          timestamp: epochMs(),
          count: value.count ?? 0,
          sum: value.sum ?? 0,
          min: value.min ?? 0,
          max: value.max ?? 0,
          avg: value.count ? (value.sum ?? 0) / value.count : 0,
        })
      }
    }

    // Process SUM data points (counters)
    if (metricData.dataPointType === DataPointType.SUM) {
      for (const dataPoint of metricData.dataPoints) {
        const value = typeof dataPoint.value === 'number' ? dataPoint.value : 0
        const labels = extractLabels(dataPoint.attributes)

        points.push({
          name: metricData.descriptor.name,
          metricType: 'counter',
          unit,
          labels,
          timestamp: epochMs(),
          count: 1,
          sum: value,
          min: value,
          max: value,
          avg: value,
        })
      }
    }

    // Process GAUGE data points
    if (metricData.dataPointType === DataPointType.GAUGE) {
      for (const dataPoint of metricData.dataPoints) {
        const value = typeof dataPoint.value === 'number' ? dataPoint.value : 0
        const labels = extractLabels(dataPoint.attributes)

        points.push({
          name: metricData.descriptor.name,
          metricType: 'gauge',
          unit,
          labels,
          timestamp: epochMs(),
          count: 1,
          sum: value,
          min: value,
          max: value,
          avg: value,
        })
      }
    }

    return points
  }

  private dataPointToEvent(point: AggregatedHistogramPoint): MetricEvent | null {
    const event: Record<string, unknown> = {
      type: 'metric',
      eventId: generateId(),
      metricName: point.name,
      metricType: point.metricType as MetricType,
      value: point.avg,
      unit: point.unit || (point.metricType === 'histogram' ? 'ms' : '1'),
      timestamp: point.timestamp,
      tags: point.labels,
      count: point.count,
      sum: point.sum,
      min: point.min,
      max: point.max,
      avg: point.avg,
      rate: 0,
    }

    // Include raw bucket data for histograms — backend computes percentiles
    if (point.buckets) {
      event['buckets'] = point.buckets
    }

    return event as unknown as MetricEvent
  }

  getStats(): { totalCollected: number; totalDropped: number } {
    return { totalCollected: this.totalCollected, totalDropped: this.totalDropped }
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

export function extractLabels(attributes: Record<string, unknown> | undefined): Record<string, string> {
  const labels: Record<string, string> = {}
  if (!attributes) return labels
  for (const [key, val] of Object.entries(attributes)) {
    if (typeof val === 'string') labels[key] = val
    else if (typeof val === 'number') labels[key] = String(val)
    else if (typeof val === 'boolean') labels[key] = String(val)
  }
  return labels
}

export const PulseMetricReader = LynkTraceMetricReader
export type PulseMetricReader = LynkTraceMetricReader
