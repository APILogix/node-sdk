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
import { getLogger } from '../utils/logger.js';
import { epochMs } from '../utils/time.js';
// ─── Implementation ─────────────────────────────────────────────────────────
const DEFAULT_TENANT = '_default';
const PRE_INIT_TENANT_GOVERNANCE = Object.freeze({
    enabled: false,
    maxTenantsTracked: 1,
    quotaPerWindow: 1,
    criticalReserve: 0,
    windowDurationMs: 60_000,
});
export class TenantGovernor {
    enabled = PRE_INIT_TENANT_GOVERNANCE.enabled;
    maxTenantsTracked = PRE_INIT_TENANT_GOVERNANCE.maxTenantsTracked;
    defaultQuota = PRE_INIT_TENANT_GOVERNANCE.quotaPerWindow;
    criticalReserve = PRE_INIT_TENANT_GOVERNANCE.criticalReserve;
    windowDurationMs = PRE_INIT_TENANT_GOVERNANCE.windowDurationMs;
    windows = new Map();
    totalThrottled = 0;
    cleanupTimer = null;
    constructor(options = PRE_INIT_TENANT_GOVERNANCE) {
        this.configure(options);
        this.cleanupTimer = setInterval(() => this.cleanup(), 30_000);
        this.cleanupTimer.unref();
    }
    configure(options) {
        this.enabled = options.enabled;
        this.maxTenantsTracked = options.maxTenantsTracked;
        this.defaultQuota = options.quotaPerWindow;
        this.criticalReserve = options.criticalReserve;
        this.windowDurationMs = options.windowDurationMs;
        this.reset();
    }
    /** Atomically check and record one event. */
    admit(tenantId, critical = false) {
        if (!this.enabled)
            return true;
        const id = tenantId?.trim() || DEFAULT_TENANT;
        const now = epochMs();
        const window = this.getOrCreateWindow(id, now);
        if (now - window.windowStart >= this.windowDurationMs) {
            window.eventCount = 0;
            window.criticalCount = 0;
            window.windowStart = now;
        }
        window.lastSeen = now;
        this.touch(id, window);
        const normalAvailable = window.eventCount < this.defaultQuota;
        const reserveAvailable = critical && window.criticalCount < this.criticalReserve;
        if (normalAvailable || reserveAvailable) {
            window.eventCount++;
            if (!normalAvailable)
                window.criticalCount++;
            return true;
        }
        window.throttledCount++;
        this.totalThrottled++;
        if (window.throttledCount % 50 === 1) {
            getLogger().warn('Tenant rate limited', {
                tenantId: id === DEFAULT_TENANT ? '(default)' : `${id.slice(0, 8)}...`,
                eventCount: window.eventCount,
                quota: this.defaultQuota,
                windowMs: this.windowDurationMs,
            });
        }
        return false;
    }
    getStats() {
        let throttledTenants = 0;
        for (const window of this.windows.values()) {
            if (window.throttledCount > 0) {
                throttledTenants++;
            }
        }
        return {
            activeTenants: this.windows.size,
            throttledTenants,
            totalThrottled: this.totalThrottled,
        };
    }
    reset() {
        this.windows.clear();
        this.totalThrottled = 0;
    }
    shutdown() {
        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer);
            this.cleanupTimer = null;
        }
    }
    // ─── Internal ───────────────────────────────────────────────────────────
    getOrCreateWindow(id, now) {
        const existing = this.windows.get(id);
        if (existing)
            return existing;
        if (this.windows.size >= this.maxTenantsTracked)
            this.evictOldest();
        const created = {
            eventCount: 0,
            criticalCount: 0,
            windowStart: now,
            lastSeen: now,
            throttledCount: 0,
        };
        this.windows.set(id, created);
        return created;
    }
    touch(id, window) {
        // Map insertion order is an O(1) LRU list for our bounded key set.
        this.windows.delete(id);
        this.windows.set(id, window);
    }
    evictOldest() {
        const oldest = this.windows.keys().next().value;
        if (oldest !== undefined)
            this.windows.delete(oldest);
    }
    cleanup() {
        const now = epochMs();
        const maxAge = this.windowDurationMs * 5; // Keep idle tenants for 5 windows
        for (const [tenantId, window] of this.windows.entries()) {
            if (now - window.lastSeen > maxAge) {
                this.windows.delete(tenantId);
            }
        }
    }
}
// ─── Singleton ──────────────────────────────────────────────────────────────
export const tenantGovernor = new TenantGovernor();
//# sourceMappingURL=tenant-isolation.js.map