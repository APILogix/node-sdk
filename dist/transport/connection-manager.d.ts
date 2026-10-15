import type { EnterpriseRoute } from './route-registry.js';
export interface ConnectionManagerOptions {
    readonly maxTotalConnections: number;
    readonly maxConnectionsPerRoute: Readonly<Record<EnterpriseRoute, number>>;
    readonly connectionTimeoutMs: number;
    readonly socketTimeoutMs: number;
    readonly connectionTTLMs: number;
    readonly idleConnectionTimeoutMs: number;
}
export interface ConnectionLease {
    readonly route: EnterpriseRoute;
    readonly acquiredAt: number;
    release(healthy?: boolean): void;
}
export interface ConnectionPoolStats {
    readonly maxTotalConnections: number;
    readonly totalInUse: number;
    readonly routeInUse: Readonly<Record<EnterpriseRoute, number>>;
    readonly routeLimits: Readonly<Record<EnterpriseRoute, number>>;
}
export declare class Semaphore {
    private readonly capacity;
    private available;
    private readonly waiters;
    constructor(capacity: number);
    acquire(timeoutMs: number): Promise<boolean>;
    release(): void;
    inUse(): number;
}
export declare class ConnectionManager {
    private readonly options;
    private readonly globalSemaphore;
    private readonly routeSemaphores;
    private readonly routeInUse;
    private totalInUse;
    constructor(options: ConnectionManagerOptions);
    acquire(route: EnterpriseRoute): Promise<ConnectionLease | null>;
    getStats(): ConnectionPoolStats;
    stats(): ConnectionPoolStats;
    getMaxForRoute(route: EnterpriseRoute): number;
    maxForRoute(route: EnterpriseRoute): number;
}
