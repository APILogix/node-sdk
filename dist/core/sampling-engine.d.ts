/**
 * SamplingEngine — deterministic, FNV-1a hash-based sampling.
 *
 * Replaces random Math.random() sampling with deterministic decisions:
 * - Same traceId → same decision across all SDK instances (consistent sampling).
 * - Route overrides: sampling.routes["/api/health"] = 0 → always drop.
 * - Dynamic rate updates via config refresh (no restart needed).
 *
 * Algorithm:
 * 1. Compute FNV-1a 32-bit hash of the traceId (or eventId).
 * 2. Normalize to [0.0, 1.0] via hash / 2^32.
 * 3. Compare against the sampling rate for the event type.
 * 4. If route override exists, use route rate instead.
 */
import type { SamplingConfig, ConfigDiff, RemoteConfigResponse } from '../types/config.js';
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
    /**
     * Decide whether to sample a trace.
     * @param traceId The trace ID (or any deterministic identifier)
     * @param route Optional URL path for route-specific overrides
     */
    shouldSampleTrace(traceId: string, route?: string): SamplingDecision;
    /** Decide whether to sample an error. */
    shouldSampleError(eventId: string): SamplingDecision;
    /** Decide whether to sample a profile. */
    shouldSampleProfile(traceId: string): SamplingDecision;
    /** Decide whether to sample a replay. */
    shouldSampleReplay(sessionId: string): SamplingDecision;
    /** Handle config change — hot-swap sampling rates. */
    handleConfigChange(_diff: ConfigDiff, newConfig: Readonly<RemoteConfigResponse>): void;
    /** Get current sampling config. */
    getConfig(): Readonly<SamplingConfig>;
    /**
     * Core sampling decision logic.
     */
    private decide;
    /**
     * Find the route-specific sampling rate by prefix match.
     * Longest prefix wins.
     */
    private findRouteRate;
    /**
     * FNV-1a 32-bit hash.
     * Deterministic, fast, and well-distributed for trace IDs.
     */
    static fnv1a32(input: string): number;
    destroy(): void;
    static reset(): void;
}
//# sourceMappingURL=sampling-engine.d.ts.map