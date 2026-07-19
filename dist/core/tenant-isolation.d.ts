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
    /** Max tenants to track simultaneously. Default: 1000 */
    readonly maxTenantsTracked?: number;
    /** Default rate limit per tenant (events per minute). Default: 100 */
    readonly defaultQuotaPerTenant?: number;
    /** Enable fair scheduling across tenants. Default: true */
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
    private readonly maxTenantsTracked;
    private readonly defaultQuota;
    private readonly windowDurationMs;
    private readonly windows;
    private totalThrottled;
    private cleanupTimer;
    constructor(options?: TenantGovernanceOptions);
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
    private evictOldest;
    private cleanup;
}
export declare const tenantGovernor: TenantGovernor;
//# sourceMappingURL=tenant-isolation.d.ts.map