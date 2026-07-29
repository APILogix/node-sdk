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

import { getLogger } from '../utils/logger.js'
import { epochMs } from '../utils/time.js'

// ─── Types ──────────────────────────────────────────────────────────────────

export interface TenantGovernanceOptions {
    /** Disabled by default until configured by the control plane. */
    readonly enabled?: boolean
    /** Max tenants to track simultaneously. Default: 1000 */
    readonly maxTenantsTracked?: number
    /** Legacy quota name. */
    readonly defaultQuotaPerTenant?: number
    /** Events accepted per window. */
    readonly quotaPerWindow?: number
    /** High-priority events accepted after normal quota. */
    readonly criticalReserve?: number
    /** Enable fair scheduling across tenants. Reserved for queue schedulers. */
    readonly enableFairScheduling?: boolean
    /** Window duration for rate limiting in ms. Default: 60000 (1 minute) */
    readonly windowDurationMs?: number
}

export interface TenantStats {
    readonly activeTenants: number
    readonly throttledTenants: number
    readonly totalThrottled: number
}

interface TenantWindow {
    eventCount: number
    criticalCount: number
    windowStart: number
    lastSeen: number
    throttledCount: number
}

// ─── Implementation ─────────────────────────────────────────────────────────

const DEFAULT_TENANT = '_default'

export class TenantGovernor {
    private enabled = false
    private maxTenantsTracked = 1000
    private defaultQuota = 100
    private criticalReserve = 25
    private windowDurationMs = 60_000
    private readonly windows = new Map<string, TenantWindow>()
    private totalThrottled = 0
    private cleanupTimer: ReturnType<typeof setInterval> | null = null

    constructor(options: TenantGovernanceOptions = {}) {
        this.configure(options)
        this.cleanupTimer = setInterval(() => this.cleanup(), 30_000)
        this.cleanupTimer.unref()
    }

    configure(options: TenantGovernanceOptions | undefined): void {
        this.enabled = options?.enabled ?? false
        this.maxTenantsTracked = Math.max(1, Math.floor(options?.maxTenantsTracked ?? 1000))
        this.defaultQuota = Math.max(1, Math.floor(options?.quotaPerWindow ?? options?.defaultQuotaPerTenant ?? 100))
        this.criticalReserve = Math.max(0, Math.floor(options?.criticalReserve ?? 25))
        this.windowDurationMs = Math.max(1000, Math.floor(options?.windowDurationMs ?? 60_000))
        this.reset()
    }

    /** Atomically check and record one event. */
    admit(tenantId: string | undefined, critical = false): boolean {
        if (!this.enabled) return true
        const id = tenantId?.trim() || DEFAULT_TENANT
        const now = epochMs()
        const window = this.getOrCreateWindow(id, now)
        if (now - window.windowStart >= this.windowDurationMs) {
            window.eventCount = 0
            window.criticalCount = 0
            window.windowStart = now
        }
        window.lastSeen = now
        this.touch(id, window)

        const normalAvailable = window.eventCount < this.defaultQuota
        const reserveAvailable = critical && window.criticalCount < this.criticalReserve
        if (normalAvailable || reserveAvailable) {
            window.eventCount++
            if (!normalAvailable) window.criticalCount++
            return true
        }

        window.throttledCount++
        this.totalThrottled++
        if (window.throttledCount % 50 === 1) {
            getLogger().warn('Tenant rate limited', {
                tenantId: id === DEFAULT_TENANT ? '(default)' : `${id.slice(0, 8)}...`,
                eventCount: window.eventCount,
                quota: this.defaultQuota,
                windowMs: this.windowDurationMs,
            })
        }
        return false
    }

    /**
     * Check if a tenant can accept another event.
     * Returns true if the event should be accepted, false if rate-limited.
     */
    canAcceptEvent(tenantId: string | undefined): boolean {
        if (!this.enabled) return true
        const id = tenantId ?? DEFAULT_TENANT
        const now = epochMs()
        let window = this.windows.get(id)

        if (!window) {
            // New tenant — check capacity
            if (this.windows.size >= this.maxTenantsTracked) {
                this.evictOldest()
            }

            window = {
                eventCount: 0,
                criticalCount: 0,
                windowStart: now,
                lastSeen: now,
                throttledCount: 0,
            }
            this.windows.set(id, window)
        }

        // Reset window if expired
        if (now - window.windowStart > this.windowDurationMs) {
            window.eventCount = 0
            window.windowStart = now
        }

        window.lastSeen = now

        // Check quota
        if (window.eventCount >= this.defaultQuota) {
            window.throttledCount++
            this.totalThrottled++

            if (window.throttledCount % 50 === 1) {
                getLogger().warn('Tenant rate limited', {
                    tenantId: id === DEFAULT_TENANT ? '(default)' : id.slice(0, 8) + '...',
                    eventCount: window.eventCount,
                    quota: this.defaultQuota,
                    windowMs: this.windowDurationMs,
                })
            }

            return false
        }

        return true
    }

    /**
     * Record that an event was accepted for a tenant.
     */
    recordEvent(tenantId: string | undefined): void {
        if (!this.enabled) return
        const id = tenantId ?? DEFAULT_TENANT
        const window = this.windows.get(id)
        if (window) {
            window.eventCount++
            window.lastSeen = epochMs()
        }
    }

    getStats(): TenantStats {
        let throttledTenants = 0
        for (const window of this.windows.values()) {
            if (window.throttledCount > 0) {
                throttledTenants++
            }
        }

        return {
            activeTenants: this.windows.size,
            throttledTenants,
            totalThrottled: this.totalThrottled,
        }
    }

    reset(): void {
        this.windows.clear()
        this.totalThrottled = 0
    }

    shutdown(): void {
        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer)
            this.cleanupTimer = null
        }
    }

    // ─── Internal ───────────────────────────────────────────────────────────

    private getOrCreateWindow(id: string, now: number): TenantWindow {
        const existing = this.windows.get(id)
        if (existing) return existing
        if (this.windows.size >= this.maxTenantsTracked) this.evictOldest()
        const created: TenantWindow = {
            eventCount: 0,
            criticalCount: 0,
            windowStart: now,
            lastSeen: now,
            throttledCount: 0,
        }
        this.windows.set(id, created)
        return created
    }

    private touch(id: string, window: TenantWindow): void {
        // Map insertion order is an O(1) LRU list for our bounded key set.
        this.windows.delete(id)
        this.windows.set(id, window)
    }

    private evictOldest(): void {
        const oldest = this.windows.keys().next().value as string | undefined
        if (oldest !== undefined) this.windows.delete(oldest)
    }

    private cleanup(): void {
        const now = epochMs()
        const maxAge = this.windowDurationMs * 5 // Keep idle tenants for 5 windows

        for (const [tenantId, window] of this.windows.entries()) {
            if (now - window.lastSeen > maxAge) {
                this.windows.delete(tenantId)
            }
        }
    }
}

// ─── Singleton ──────────────────────────────────────────────────────────────

export const tenantGovernor = new TenantGovernor()
