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
    shouldSampleTrace(traceId, route) {
        return this.decide(traceId, 'traces', route);
    }
    shouldSampleRequest(requestId, route) {
        return this.decide(requestId, 'requests', route);
    }
    shouldSampleError(eventId, route) {
        return this.decide(eventId, 'errors', route);
    }
    shouldSampleProfile(traceId, route) {
        return this.decide(traceId, 'profiles', route);
    }
    shouldSampleReplay(sessionId) {
        return this.decide(sessionId, 'replays');
    }
    shouldSampleMetric(metricId, route) {
        return this.decide(metricId, 'metrics', route);
    }
    // ─── Config Change ────────────────────────────────────────────────────────
    handleConfigChange(_diff, newConfig) {
        if (this.destroyed)
            return;
        const newSampling = newConfig.sampling;
        const old = this.config;
        if (old.traces !== newSampling.traces ||
            old.requests !== newSampling.requests ||
            old.errors !== newSampling.errors ||
            old.profiles !== newSampling.profiles ||
            old.replays !== newSampling.replays ||
            old.metrics !== newSampling.metrics) {
            getLogger().info(`[SamplingEngine] Rates updated — traces: ${newSampling.traces}, requests: ${newSampling.requests}, errors: ${newSampling.errors}, profiles: ${newSampling.profiles}, replays: ${newSampling.replays}, metrics: ${newSampling.metrics}`);
        }
        this.config = { ...newSampling };
    }
    getConfig() {
        return { ...this.config };
    }
    // ─── Private ──────────────────────────────────────────────────────────────
    decide(id, eventType, route) {
        // 1. Per-route override (longest prefix match) — applies to all event types.
        if (route) {
            const routeRates = this.findRouteRates(route);
            if (routeRates) {
                const routeRate = routeRates[eventType];
                if (routeRate !== undefined) {
                    return this.evaluate(id, routeRate, 'route_override');
                }
            }
        }
        // 2. Fall through to the global rate.
        const rate = this.config[eventType];
        return this.evaluate(id, rate, 'global_rate');
    }
    evaluate(id, rate, reason) {
        if (rate <= 0)
            return { sampled: false, rate: 0, reason: 'always_drop' };
        if (rate >= 1)
            return { sampled: true, rate: 1, reason: 'always_sample' };
        const hash = SamplingEngine.fnv1a32(id);
        const normalized = hash / 0x100000000;
        return {
            sampled: normalized < rate,
            rate,
            reason,
        };
    }
    /**
     * Find the route-specific override map by longest-prefix match.
     * Returns the matched RouteSamplingRates record, or null.
     */
    findRouteRates(route) {
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
        return bestMatch !== null ? routes[bestMatch] ?? null : null;
    }
    /**
     * FNV-1a 32-bit hash. Deterministic and fast.
     */
    static fnv1a32(input) {
        let hash = 0x811c9dc5;
        for (let i = 0; i < input.length; i++) {
            hash ^= input.charCodeAt(i);
            hash = Math.imul(hash, 0x01000193);
        }
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
