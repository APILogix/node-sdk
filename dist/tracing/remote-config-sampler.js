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
import { SamplingDecision } from '@opentelemetry/sdk-trace-base';
import { SamplingEngine } from '../core/sampling-engine.js';
export class RemoteConfigSampler {
    shouldSample(_context, traceId, _spanName, _spanKind, attributes, _links) {
        const samplingEngine = SamplingEngine.getInstance();
        if (!samplingEngine) {
            // Record locally so error-bearing spans remain eligible, but do not
            // mark ordinary spans sampled without an authoritative snapshot.
            return { decision: SamplingDecision.RECORD };
        }
        const httpUrl = attributes['http.url'];
        const httpTarget = attributes['http.target'];
        const httpRoute = attributes['http.route'];
        const url = httpRoute ?? httpTarget ?? httpUrl ?? '';
        // Per-route filtering happens inside SamplingEngine via the `routes` map.
        // A rate of 0 on a matching prefix already means "always drop".
        const decision = samplingEngine.shouldSampleTrace(traceId, url || undefined);
        return decision.sampled
            ? { decision: SamplingDecision.RECORD_AND_SAMPLED }
            // RECORD (not NOT_RECORD) so spans are still collected in memory.
            // PipelineSpanExporter will promote error-bearing spans to exported
            // even when not sampled — this is the SDK-side tail-sampling strategy
            // for error-priority capture.
            : { decision: SamplingDecision.RECORD };
    }
    toString() {
        return 'RemoteConfigSampler';
    }
}
//# sourceMappingURL=remote-config-sampler.js.map