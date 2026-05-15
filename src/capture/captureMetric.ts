/**
 * Metric capture — captures counter, gauge, and histogram metric events.
 */

import type { MetricEvent, MetricType } from '../types/event.js'
import { captureEvent } from './captureEvent.js'
import { getLogger } from '../utils/logger.js'
import { epochMs } from '../utils/time.js'

/**
 * Capture a metric sample.
 *
 * @param name - Metric name (e.g. 'http.request.duration')
 * @param value - Numeric value
 * @param type - Metric type: 'counter', 'gauge', or 'histogram'
 * @param options - Optional tags and unit
 */
export function captureMetric(
  name: string,
  value: number,
  type: MetricType = 'gauge',
  options?: { tags?: Record<string, string>; unit?: string }
): void {
  const logger = getLogger()

  try {
    const event: MetricEvent = {
      type: 'metric',
      metricName: name,
      metricType: type,
      value,
      unit: options?.unit,
      tags: options?.tags,
      timestamp: epochMs(),
    }

    captureEvent(event)
  } catch (err) {
    logger.error('captureMetric failed', { error: err, metricName: name })
  }
}

// ─── Convenience Methods ────────────────────────────────────────────────────

/** Increment a counter metric by the given value (default: 1). */
export function incrementCounter(
  name: string,
  value = 1,
  tags?: Record<string, string>
): void {
  captureMetric(name, value, 'counter', tags ? { tags } : undefined)
}

/** Set a gauge metric to the given value. */
export function setGauge(
  name: string,
  value: number,
  tags?: Record<string, string>
): void {
  captureMetric(name, value, 'gauge', tags ? { tags } : undefined)
}

/** Record a histogram value (e.g., latency, size). */
export function recordHistogram(
  name: string,
  value: number,
  tags?: Record<string, string>,
  unit?: string
): void {
  const opts: { tags?: Record<string, string>; unit?: string } = {}
  if (tags) opts.tags = tags
  if (unit) opts.unit = unit
  captureMetric(name, value, 'histogram', Object.keys(opts).length > 0 ? opts : undefined)
}
