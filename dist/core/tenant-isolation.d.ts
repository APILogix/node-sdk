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
 * - Per-tenant window admission
 * - Critical-event reserve
 * - LRU-bounded tenant tracking
 */
import type { TenantGovernanceConfig } from '../types/config.js';
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
    constructor(options?: TenantGovernanceConfig);
    configure(options: TenantGovernanceConfig): void;
    /** Atomically check and record one event. */
    admit(tenantId: string | undefined, critical?: boolean): boolean;
    getStats(): TenantStats;
    reset(): void;
    /**
     * Start the background cleanup timer if not running.
     */
    start(): void;
    shutdown(): void;
    private getOrCreateWindow;
    private touch;
    private evictOldest;
    private cleanup;
}
export declare const tenantGovernor: TenantGovernor;
