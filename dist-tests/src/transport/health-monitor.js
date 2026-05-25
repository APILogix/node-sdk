const FAILURE_WINDOW_MS = 60_000;
const FAILURE_THRESHOLD = 10;
const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;
const P99_DEGRADED_THRESHOLD_MS = 5_000;
class RouteHealth {
    route;
    state = 'HEALTHY';
    circuit = 'CLOSED';
    failures = [];
    latencies = [];
    backoffMs = INITIAL_BACKOFF_MS;
    probeInFlight = false;
    openUntil = 0;
    lastError = null;
    lastSuccess = null;
    constructor(route) {
        this.route = route;
    }
    canSend() {
        if (this.circuit !== 'OPEN')
            return true;
        const now = Date.now();
        if (now < this.openUntil || this.probeInFlight)
            return false;
        this.circuit = 'HALF_OPEN';
        this.probeInFlight = true;
        return true;
    }
    recordSuccess(latencyMs) {
        this.lastSuccess = Date.now();
        this.probeInFlight = false;
        this.failures.length = 0;
        this.trackLatency(latencyMs);
        this.circuit = 'CLOSED';
        this.state = this.p99Latency() > P99_DEGRADED_THRESHOLD_MS ? 'DEGRADED' : 'HEALTHY';
        this.backoffMs = INITIAL_BACKOFF_MS;
    }
    recordFailure() {
        const now = Date.now();
        this.lastError = now;
        this.probeInFlight = false;
        this.failures.push(now);
        this.pruneFailures(now);
        if (this.failures.length >= FAILURE_THRESHOLD || this.circuit === 'HALF_OPEN') {
            this.state = 'UNAVAILABLE';
            this.circuit = 'OPEN';
            this.openUntil = now + this.backoffMs;
            this.backoffMs = Math.min(MAX_BACKOFF_MS, this.backoffMs * 2);
            return;
        }
        this.state = 'DEGRADED';
    }
    concurrencyScale() {
        if (this.state === 'HEALTHY')
            return 1;
        if (this.state === 'DEGRADED')
            return 0.5;
        return this.canSend() ? 0.05 : 0;
    }
    batchScale() {
        if (this.state === 'DEGRADED')
            return 0.5;
        if (this.state === 'UNAVAILABLE')
            return 2;
        return 1;
    }
    snapshot() {
        const now = Date.now();
        this.pruneFailures(now);
        return {
            route: this.route,
            healthState: this.state,
            circuitState: this.circuit,
            failureCount: this.failures.length,
            avgLatencyMs: this.latencies.length > 0 ? this.latencies.reduce((sum, value) => sum + value, 0) / this.latencies.length : 0,
            p99LatencyMs: this.p99Latency(),
            nextProbeAt: this.circuit === 'OPEN' ? this.openUntil : null,
            lastErrorAt: this.lastError,
            lastSuccessAt: this.lastSuccess,
        };
    }
    trackLatency(latencyMs) {
        this.latencies.push(latencyMs);
        if (this.latencies.length > 200)
            this.latencies.shift();
    }
    p99Latency() {
        if (this.latencies.length === 0)
            return 0;
        const sorted = [...this.latencies].sort((a, b) => a - b);
        const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.99) - 1);
        return sorted[index] ?? 0;
    }
    pruneFailures(now) {
        const cutoff = now - FAILURE_WINDOW_MS;
        while (this.failures.length > 0 && (this.failures[0] ?? 0) < cutoff) {
            this.failures.shift();
        }
    }
}
export class HealthMonitor {
    routes = new Map();
    constructor(routeNames) {
        for (const route of routeNames) {
            this.routes.set(route, new RouteHealth(route));
        }
    }
    canSend(route) {
        return this.routes.get(route)?.canSend() ?? false;
    }
    recordSuccess(route, latencyMs) {
        this.routes.get(route)?.recordSuccess(latencyMs);
    }
    recordFailure(route) {
        this.routes.get(route)?.recordFailure();
    }
    concurrencyScale(route) {
        return this.routes.get(route)?.concurrencyScale() ?? 0;
    }
    batchScale(route) {
        return this.routes.get(route)?.batchScale() ?? 1;
    }
    snapshot(route) {
        const health = this.routes.get(route);
        if (!health) {
            return {
                route,
                healthState: 'UNAVAILABLE',
                circuitState: 'OPEN',
                failureCount: 0,
                avgLatencyMs: 0,
                p99LatencyMs: 0,
                nextProbeAt: null,
                lastErrorAt: null,
                lastSuccessAt: null,
            };
        }
        return health.snapshot();
    }
}
