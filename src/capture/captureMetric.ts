/**
 * Metric capture — captures counter, gauge, and histogram metric events.
 *
 * Histograms use OpenTelemetry exponential histograms for O(1) recording
 * and high-precision percentile computation.
 * Counters/gauges use the enterprise metrics registry for aggregation.
 */

import type { MetricEvent, MetricType } from '../types/event.js'
import { captureEvent } from './captureEvent.js'
import { getLogger } from '../utils/logger.js'
import { epochMs } from '../utils/time.js'
import { metricsRegistry } from '../metrics/registry.js'
import { KillswitchEngine } from '../core/killswitch-engine.js'
import { EntitlementGate } from '../core/entitlement-gate.js'

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
    if (!admitMetric(name, options?.tags)) return

    const labels = options?.tags ?? {}
    if (type === 'histogram') {
      metricsRegistry.recordHistogram(name, value, { labels })
      return
    }
    if (type === 'counter') {
      metricsRegistry.incrementCounter(name, value, { labels })
      return
    }
    if (type === 'gauge') {
      metricsRegistry.setGauge(name, value, { labels })
      return
    }

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

function admitMetric(_name: string, _tags?: Record<string, string>): boolean {
  if (!EntitlementGate.isAllowed('customMetrics')) return false
  return !KillswitchEngine.getInstance()?.isKilled('disableMetrics')
}

// ─── Convenience Methods ────────────────────────────────────────────────────

/** Increment a counter metric by the given value (default: 1). */
export function incrementCounter(
  name: string,
  value = 1,
  tags?: Record<string, string>
): void {
  if (!admitMetric(name, tags)) return
  metricsRegistry.incrementCounter(name, value, { labels: tags ?? {} })
}

/** Set a gauge metric to the given value. */
export function setGauge(
  name: string,
  value: number,
  tags?: Record<string, string>
): void {
  if (!admitMetric(name, tags)) return
  metricsRegistry.setGauge(name, value, { labels: tags ?? {} })
}

/** Record a histogram value (e.g., latency, size) using OTel exponential histogram. */
export function recordHistogram(
  name: string,
  value: number,
  tags?: Record<string, string>,
  unit?: string
): void {
  if (!admitMetric(name, tags)) return
  metricsRegistry.recordHistogram(name, value, { labels: tags ?? {} })
}

/**
 * Add to an up-down counter (can go negative).
 * Used for tracking active connections, queue depth, etc.
 */
export function addUpDownCounter(
  name: string,
  value: number,
  tags?: Record<string, string>
): void {
  if (!admitMetric(name, tags)) return
  metricsRegistry.addUpDownCounter(name, value, { labels: tags ?? {} })
}
