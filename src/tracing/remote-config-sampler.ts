/**
 * RemoteConfigSampler — custom OpenTelemetry Sampler driven by SamplingEngine.
 *
 * Replaces the default TraceIdRatioBasedSampler with a sampler that:
 *   1. Uses FNV-1a hash of traceId for deterministic sampling decisions.
 *   2. Checks per-route per-event-type overrides from `sampling.routes`.
 *
 * The wire schema dropped the `tracing.ignoredRoutes` and
 * `tracing.ignoredMethods` arrays — those concerns are now expressed as
 * `sampling.routes["/health"] = { traces: 0, ... }`. The SamplingEngine
 * already understands per-route rates, so this sampler is a thin shim.
 *
 * The sampling decision is made ONCE at the root span and propagated
 * to all child spans via the sampled bit in traceparent header.
 */

import type { SamplingResult } from '@opentelemetry/sdk-trace-base'
import { SamplingDecision } from '@opentelemetry/sdk-trace-base'
import type { Context, SpanKind, Attributes, Link } from '@opentelemetry/api'
import { SamplingEngine } from '../core/sampling-engine.js'

export class RemoteConfigSampler {
  shouldSample(
    _context: Context,
    traceId: string,
    _spanName: string,
    _spanKind: SpanKind,
    attributes: Attributes,
    _links: Link[]
  ): SamplingResult {
    const samplingEngine = SamplingEngine.getInstance()

    if (!samplingEngine) {
      // Fallback: sample everything if engine not initialized
      return { decision: SamplingDecision.RECORD_AND_SAMPLED }
    }

    const httpUrl = attributes['http.url'] as string | undefined
    const httpTarget = attributes['http.target'] as string | undefined
    const httpRoute = attributes['http.route'] as string | undefined
    const url = httpRoute ?? httpTarget ?? httpUrl ?? ''

    // Per-route filtering happens inside SamplingEngine via the `routes` map.
    // A rate of 0 on a matching prefix already means "always drop".
    const decision = samplingEngine.shouldSampleTrace(traceId, url || undefined)

    return decision.sampled
      ? { decision: SamplingDecision.RECORD_AND_SAMPLED }
      : { decision: SamplingDecision.NOT_RECORD }
  }

  toString(): string {
    return 'RemoteConfigSampler'
  }
}
