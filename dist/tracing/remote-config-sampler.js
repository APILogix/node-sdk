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
import { SamplingDecision } from '@opentelemetry/sdk-trace-base';
import { SamplingEngine } from '../core/sampling-engine.js';
import { ConfigManager } from '../core/config-manager.js';
export class RemoteConfigSampler {
    shouldSample(_context, traceId, _spanName, _spanKind, attributes, _links) {
        const samplingEngine = SamplingEngine.getInstance();
        if (!samplingEngine) {
            // Fallback: sample everything if engine not initialized
            return { decision: SamplingDecision.RECORD_AND_SAMPLED };
        }
        // Check if request URL matches ignoredRoutes
        const httpUrl = attributes['http.url'];
        const httpTarget = attributes['http.target'];
        const httpRoute = attributes['http.route'];
        const httpMethod = attributes['http.method'];
        const url = httpRoute ?? httpTarget ?? httpUrl ?? '';
        try {
            const config = ConfigManager.getInstance().getConfig();
            // Check ignoredRoutes
            if (url && config.tracing.ignoredRoutes.some(r => url === r || url.startsWith(r))) {
                return { decision: SamplingDecision.NOT_RECORD };
            }
            // Check ignoredMethods
            if (httpMethod && config.tracing.ignoredMethods.includes(httpMethod.toUpperCase())) {
                return { decision: SamplingDecision.NOT_RECORD };
            }
        }
        catch {
            // ConfigManager may not be initialized
        }
        // Use SamplingEngine for deterministic FNV-1a decision with route overrides
        const decision = samplingEngine.shouldSampleTrace(traceId, url || undefined);
        if (decision.sampled) {
            return { decision: SamplingDecision.RECORD_AND_SAMPLED };
        }
        else {
            return { decision: SamplingDecision.NOT_RECORD };
        }
    }
    toString() {
        return 'RemoteConfigSampler';
    }
}
//# sourceMappingURL=remote-config-sampler.js.map