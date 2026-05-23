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
import { getLogger } from '../utils/logger.js';
export class SamplingEngine {
    static instance = null;
    config;
    destroyed = false;
    constructor(config) {
        this.config = { ...config };
    }
    static initialize(config) {
        if (SamplingEngine.instance) {
            SamplingEngine.instance.destroy();
        }
        SamplingEngine.instance = new SamplingEngine(config);
        return SamplingEngine.instance;
    }
    static getInstance() {
        return SamplingEngine.instance;
    }
    // ─── Sampling Decision API ────────────────────────────────────────────────
    /**
     * Decide whether to sample a trace.
     * @param traceId The trace ID (or any deterministic identifier)
     * @param route Optional URL path for route-specific overrides
     */
    shouldSampleTrace(traceId, route) {
        return this.decide(traceId, 'traces', route);
    }
    /** Decide whether to sample an error. */
    shouldSampleError(eventId) {
        return this.decide(eventId, 'errors');
    }
    /** Decide whether to sample a profile. */
    shouldSampleProfile(traceId) {
        return this.decide(traceId, 'profiles');
    }
    /** Decide whether to sample a replay. */
    shouldSampleReplay(sessionId) {
        return this.decide(sessionId, 'replays');
    }
    // ─── Config Change ────────────────────────────────────────────────────────
    /** Handle config change — hot-swap sampling rates. */
    handleConfigChange(_diff, newConfig) {
        if (this.destroyed)
            return;
        const newSampling = newConfig.sampling;
        const logger = getLogger();
        if (this.config.traces !== newSampling.traces ||
            this.config.errors !== newSampling.errors ||
            this.config.profiles !== newSampling.profiles ||
            this.config.replays !== newSampling.replays) {
            logger.info(`[SamplingEngine] Rates updated — traces: ${newSampling.traces}, errors: ${newSampling.errors}, profiles: ${newSampling.profiles}, replays: ${newSampling.replays}`);
        }
        this.config = { ...newSampling };
    }
    /** Get current sampling config. */
    getConfig() {
        return { ...this.config };
    }
    // ─── Private ──────────────────────────────────────────────────────────────
    /**
     * Core sampling decision logic.
     */
    decide(id, eventType, route) {
        // Check route-specific override
        if (route && eventType === 'traces') {
            const routeRate = this.findRouteRate(route);
            if (routeRate !== null) {
                if (routeRate === 0)
                    return { sampled: false, rate: 0, reason: 'always_drop' };
                if (routeRate === 1)
                    return { sampled: true, rate: 1, reason: 'always_sample' };
                const hash = SamplingEngine.fnv1a32(id);
                const normalized = hash / 0x100000000; // Normalize to [0.0, 1.0)
                return {
                    sampled: normalized < routeRate,
                    rate: routeRate,
                    reason: 'route_override',
                };
            }
        }
        // Global rate for this event type
        const rate = this.config[eventType];
        if (rate === 0)
            return { sampled: false, rate: 0, reason: 'always_drop' };
        if (rate >= 1)
            return { sampled: true, rate: 1, reason: 'always_sample' };
        const hash = SamplingEngine.fnv1a32(id);
        const normalized = hash / 0x100000000;
        return {
            sampled: normalized < rate,
            rate,
            reason: 'global_rate',
        };
    }
    /**
     * Find the route-specific sampling rate by prefix match.
     * Longest prefix wins.
     */
    findRouteRate(route) {
        const routes = this.config.routes;
        if (!routes || Object.keys(routes).length === 0)
            return null;
        let bestMatch = null;
        let bestLength = 0;
        for (const pattern of Object.keys(routes)) {
            if (route.startsWith(pattern) && pattern.length > bestLength) {
                bestMatch = pattern;
                bestLength = pattern.length;
            }
        }
        return bestMatch !== null ? routes[bestMatch] : null;
    }
    /**
     * FNV-1a 32-bit hash.
     * Deterministic, fast, and well-distributed for trace IDs.
     */
    static fnv1a32(input) {
        let hash = 0x811c9dc5; // FNV offset basis
        for (let i = 0; i < input.length; i++) {
            hash ^= input.charCodeAt(i);
            // FNV prime: 16777619
            // Using Math.imul for 32-bit integer multiplication
            hash = Math.imul(hash, 0x01000193);
        }
        // Ensure unsigned 32-bit integer
        return hash >>> 0;
    }
    destroy() {
        this.destroyed = true;
        SamplingEngine.instance = null;
    }
    static reset() {
        if (SamplingEngine.instance) {
            SamplingEngine.instance.destroy();
        }
    }
}
