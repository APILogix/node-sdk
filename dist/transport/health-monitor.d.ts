import type { EnterpriseRoute } from './route-registry.js';
export type RouteHealthState = 'HEALTHY' | 'DEGRADED' | 'UNAVAILABLE';
export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';
export interface RouteHealthSnapshot {
    readonly route: EnterpriseRoute;
    readonly healthState: RouteHealthState;
    readonly circuitState: CircuitState;
    readonly failureCount: number;
    readonly avgLatencyMs: number;
    readonly p99LatencyMs: number;
    readonly nextProbeAt: number | null;
    readonly lastErrorAt: number | null;
    readonly lastSuccessAt: number | null;
}
export declare class HealthMonitor {
    private readonly routes;
    constructor(routeNames: readonly EnterpriseRoute[]);
    canSend(route: EnterpriseRoute): boolean;
    recordSuccess(route: EnterpriseRoute, latencyMs: number): void;
    recordFailure(route: EnterpriseRoute): void;
    concurrencyScale(route: EnterpriseRoute): number;
    batchScale(route: EnterpriseRoute): number;
    snapshot(route: EnterpriseRoute): RouteHealthSnapshot;
}
//# sourceMappingURL=health-monitor.d.ts.map