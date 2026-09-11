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
import type { SamplingResult } from '@opentelemetry/sdk-trace-base';
import type { Context, SpanKind, Attributes, Link } from '@opentelemetry/api';
export declare class RemoteConfigSampler {
    shouldSample(_context: Context, traceId: string, _spanName: string, _spanKind: SpanKind, attributes: Attributes, _links: Link[]): SamplingResult;
    toString(): string;
}
/**
 * LocalRecordSampler — sampler used by ParentBasedSampler for local child spans
 * whose parent was recorded (SamplingDecision.RECORD) but not export-sampled.
 *
 * OpenTelemetry's default ParentBasedSampler routes `localParentNotSampled` to
 * `AlwaysOffSampler` (which drops spans via `NOT_RECORD`).
 *
 * By using `LocalRecordSampler` returning `SamplingDecision.RECORD`, all child spans
 * created within the Node.js process under an unsampled root span are preserved in memory
 * and delivered to `PipelineSpanExporter` and `TraceAggregator`. This allows the SDK to
 * make reliable tail-sampling decisions (retaining traces that encounter errors, exceptions,
 * or exceed latency thresholds) without losing child spans.
 */
export declare class LocalRecordSampler {
    shouldSample(_context: Context, _traceId: string, _spanName: string, _spanKind: SpanKind, _attributes: Attributes, _links: Link[]): SamplingResult;
    toString(): string;
}
