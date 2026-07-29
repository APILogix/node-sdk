/**
 * Tenant Governor — shared singleton SDK runtime with per-tenant governance.
 *
 * Architecture principle (enterprise-grade):
 * - ONE SDK runtime instance per application/process
 * - Tenant/org/project identified through request-level metadata
 * - Backend-driven configuration per tenant
 * - NO per-tenant SDK instances, exporters, or queues
 *
 * This module provides:
 * - Per-tenant sliding window rate limiting
 * - Fair scheduling across tenants
 * - Starvation prevention
 * - LRU eviction for tenant tracking
 */
export interface TenantGovernanceOptions {
    /** Disabled by default until configured by the control plane. */
    readonly enabled?: boolean;
    /** Max tenants to track simultaneously. Default: 1000 */
    readonly maxTenantsTracked?: number;
    /** Legacy quota name. */
    readonly defaultQuotaPerTenant?: number;
    /** Events accepted per window. */
    readonly quotaPerWindow?: number;
    /** High-priority events accepted after normal quota. */
    readonly criticalReserve?: number;
    /** Enable fair scheduling across tenants. Reserved for queue schedulers. */
    readonly enableFairScheduling?: boolean;
    /** Window duration for rate limiting in ms. Default: 60000 (1 minute) */
    readonly windowDurationMs?: number;
}
export interface TenantStats {
    readonly activeTenants: number;
    readonly throttledTenants: number;
    readonly totalThrottled: number;
}
export declare class TenantGovernor {
    private enabled;
    private maxTenantsTracked;
    private defaultQuota;
    private criticalReserve;
    private windowDurationMs;
    private readonly windows;
    private totalThrottled;
    private cleanupTimer;
    constructor(options?: TenantGovernanceOptions);
    configure(options: TenantGovernanceOptions | undefined): void;
    /** Atomically check and record one event. */
    admit(tenantId: string | undefined, critical?: boolean): boolean;
    /**
     * Check if a tenant can accept another event.
     * Returns true if the event should be accepted, false if rate-limited.
     */
    canAcceptEvent(tenantId: string | undefined): boolean;
    /**
     * Record that an event was accepted for a tenant.
     */
    recordEvent(tenantId: string | undefined): void;
    getStats(): TenantStats;
    reset(): void;
    shutdown(): void;
    private getOrCreateWindow;
    private touch;
    private evictOldest;
    private cleanup;
}
export declare const tenantGovernor: TenantGovernor;
//# sourceMappingURL=tenant-isolation.d.ts.map