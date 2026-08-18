/**
 * SamplingEngine — deterministic, FNV-1a hash-based sampling.
 *
 * Replaces random Math.random() sampling with deterministic decisions:
 *   - Same traceId → same decision across all SDK instances (consistent
 *     sampling), so a downstream service either has the same span as its
 *     caller or it has none.
 *   - Per-route overrides are now per-event-type. The wire schema looks
 *     like: `routes: { "/health": { traces: 0, requests: 0 }, ... }`. A
 *     missing event-type key inside a route falls through to the global
 *     rate. A rate of 0 effectively replaces the old `ignoredRoutes` list.
 *   - Hot-swappable via config refresh — no SDK restart.
 *
 * Algorithm:
 *   1. FNV-1a 32-bit hash of the id.
 *   2. Normalize to [0.0, 1.0) by dividing by 2^32.
 *   3. Compare against the rate for the event type (route-overridden if any).
 */
import type { SamplingConfig, ConfigDiff, RemoteConfigResponse } from '../types/config.js';
export type SamplingEventType = 'traces' | 'requests' | 'spans' | 'errors' | 'messages' | 'profiles' | 'replays' | 'metrics' | 'logs' | 'events' | 'crons';
export type SamplingDecision = {
    readonly sampled: boolean;
    readonly rate: number;
    readonly reason: 'global_rate' | 'route_override' | 'always_sample' | 'always_drop';
};
export declare class SamplingEngine {
    private static instance;
    private config;
    private destroyed;
    private constructor();
    static initialize(config: SamplingConfig): SamplingEngine;
    static getInstance(): SamplingEngine | null;
    shouldSampleTrace(traceId: string, route?: string): SamplingDecision;
    shouldSampleRequest(requestId: string, route?: string): SamplingDecision;
    shouldSampleSpan(spanId: string, route?: string): SamplingDecision;
    shouldSampleError(eventId: string, route?: string): SamplingDecision;
    shouldSampleMessage(messageId: string, route?: string): SamplingDecision;
    shouldSampleProfile(traceId: string, route?: string): SamplingDecision;
    shouldSampleReplay(sessionId: string): SamplingDecision;
    shouldSampleMetric(metricId: string, route?: string): SamplingDecision;
    shouldSampleLog(logId: string, route?: string): SamplingDecision;
    shouldSampleEvent(eventId: string, route?: string): SamplingDecision;
    shouldSampleCron(cronId: string, route?: string): SamplingDecision;
    handleConfigChange(_diff: ConfigDiff, newConfig: Readonly<RemoteConfigResponse>): void;
    getConfig(): Readonly<SamplingConfig>;
    private decide;
    private evaluate;
    /**
     * Find the route-specific override map by longest-prefix match.
     * Returns the matched RouteSamplingRates record, or null.
     */
    private findRouteRates;
    /**
     * FNV-1a 32-bit hash. Deterministic and fast.
     */
    static fnv1a32(input: string): number;
    destroy(): void;
    static reset(): void;
}
//# sourceMappingURL=sampling-engine.d.ts.map