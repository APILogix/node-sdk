/**
 * RemoteConfigSampler — custom OpenTelemetry Sampler driven by SamplingEngine.
 *
 * Replaces the default TraceIdRatioBasedSampler with a sampler that:
 * 1. Uses FNV-1a hash of traceId for deterministic sampling decisions
 * 2. Checks per-route overrides from sampling.routes config
 * 3. Respects tracing.ignoredRoutes (always drop)
 * 4. Respects tracing.ignoredMethods (always drop)
 *
 * The sampling decision is made ONCE at the root span and propagated
 * to all child spans via the sampled bit in traceparent header.
 */
import type { SamplingResult } from '@opentelemetry/sdk-trace-base';
import type { Context, SpanKind, Attributes, Link } from '@opentelemetry/api';
export declare class RemoteConfigSampler {
    shouldSample(_context: Context, traceId: string, _spanName: string, _spanKind: SpanKind, attributes: Attributes, _links: Link[]): SamplingResult;
    toString(): string;
}
//# sourceMappingURL=remote-config-sampler.d.ts.map