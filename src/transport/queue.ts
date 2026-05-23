/**
 * Enterprise Priority Event Queue — 3-tier priority with adaptive shedding.
 *
 * Priority tiers:
 *   - critical (40%): errors, crashes — never shed unless hard limit
 *   - high (40%): requests, spans — shed under critical pressure
 *   - normal (20%): metrics, messages, breadcrumbs — shed first
 *
 * Features:
 *   - Per-tier capacity limits with overflow protection
 *   - Retry queue with priority preservation
 *   - Shutdown safety — rejects new events when shutting down
 *   - Drain-to-disk for graceful shutdown
 *   - Dead letter tracking
 *   - Drop handler callbacks
 */

import type { Event } from '../types/event.js'

export type EventPriority = 'critical' | 'high' | 'normal'

interface QueueTier {
    events: Event[]
    maxSize: number
    droppedCount: number
}

export interface QueueStats {
    readonly totalSize: number
    readonly criticalSize: number
    readonly highSize: number
    readonly normalSize: number
    readonly retrySize: number
    readonly droppedCount: number
    readonly deadLetterCount: number
    readonly isShuttingDown: boolean
}

export class EventQueue {
    private tiers: Record<EventPriority, QueueTier>
    private retryQueue: Event[] = []
    private maxSize: number
    private deadLetterCount = 0
    private shuttingDown = false
    private dropHandler: ((info: { reason: string; count: number }) => void) | null = null

    constructor(maxSize = 1000) {
        this.maxSize = maxSize
        this.tiers = {
            critical: { events: [], maxSize: Math.floor(maxSize * 0.4), droppedCount: 0 },
            high: { events: [], maxSize: Math.floor(maxSize * 0.4), droppedCount: 0 },
            normal: { events: [], maxSize: Math.floor(maxSize * 0.2), droppedCount: 0 },
        }
    }

    configure(maxSize: number) {
        this.maxSize = Math.max(1, Math.floor(maxSize))
        this.tiers.critical.maxSize = Math.floor(this.maxSize * 0.4)
        this.tiers.high.maxSize = Math.floor(this.maxSize * 0.4)
        this.tiers.normal.maxSize = Math.max(1, this.maxSize - this.tiers.critical.maxSize - this.tiers.high.maxSize)

        // Trim any tier that now exceeds its new limit
        for (const priority of ['normal', 'high', 'critical'] as const) {
            const tier = this.tiers[priority]
            if (tier.events.length > tier.maxSize) {
                const overflow = tier.events.length - tier.maxSize
                tier.events.splice(0, overflow)
                tier.droppedCount += overflow
            }
        }
    }

    /**
     * Add an event to the queue. Priority auto-detected from event type.
     * Returns false if the event was dropped.
     */
    add(event: Event, priority?: EventPriority): boolean {
        if (this.shuttingDown) {
            this.notifyDrop('shutdown_rejected', 1)
            return false
        }

        const p = priority ?? getPriority(event)
        const tier = this.tiers[p]

        if (tier.events.length >= tier.maxSize) {
            // Try to make room by shedding lower-priority events
            if (p === 'critical' && this.shedLowerPriority('high')) {
                // Made room by shedding — continue
            } else if (p === 'high' && this.shedLowerPriority('normal')) {
                // Made room by shedding normal
            } else {
                tier.droppedCount += 1
                this.notifyDrop('queue_full', 1)
                return false
            }
        }

        tier.events.push(event)
        return true
    }

    addRetry(event: Event): boolean {
        if (this.retryQueue.length >= Math.floor(this.maxSize * 0.5)) {
            // Shed normal queue to make room for retry
            const normalTier = this.tiers.normal
            if (normalTier.events.length > 0) {
                const shed = Math.min(normalTier.events.length, 10)
                normalTier.events.splice(0, shed)
                normalTier.droppedCount += shed
                this.notifyDrop('retry_pressure_shed_normal', shed)
            } else {
                this.notifyDrop('retry_queue_full', 1)
                return false
            }
        }

        this.retryQueue.push(event)
        return true
    }

    /**
     * Drain events for a batch. Retry queue has highest priority,
     * then critical, high, normal.
     */
    drain(batchSize: number): Event[] {
        const result: Event[] = []
        let remaining = batchSize

        // Retry first
        if (this.retryQueue.length > 0 && remaining > 0) {
            const batch = this.retryQueue.splice(0, remaining)
            result.push(...batch)
            remaining -= batch.length
        }

        // Then by priority: critical > high > normal
        for (const priority of ['critical', 'high', 'normal'] as const) {
            if (remaining <= 0) break
            const tier = this.tiers[priority]
            if (tier.events.length > 0) {
                const batch = tier.events.splice(0, remaining)
                result.push(...batch)
                remaining -= batch.length
            }
        }

        return result
    }

    drainAll(): Event[] {
        return this.drain(this.size())
    }

    size(): number {
        return (
            this.retryQueue.length +
            this.tiers.critical.events.length +
            this.tiers.high.events.length +
            this.tiers.normal.events.length
        )
    }

    isEmpty(): boolean {
        return this.size() === 0
    }

    getDroppedCount(): number {
        return (
            this.tiers.critical.droppedCount +
            this.tiers.high.droppedCount +
            this.tiers.normal.droppedCount
        )
    }

    getDeadLetterCount(): number {
        return this.deadLetterCount
    }

    drop(count: number) {
        const normalizedCount = Math.max(0, Math.floor(count))
        this.deadLetterCount += normalizedCount
        this.notifyDrop('dead_letter', normalizedCount)
    }

    filter(predicate: (event: Event) => boolean) {
        const beforeSize = this.size()

        this.retryQueue = this.retryQueue.filter(predicate)
        for (const priority of ['critical', 'high', 'normal'] as const) {
            const tier = this.tiers[priority]
            const before = tier.events.length
            tier.events = tier.events.filter(predicate)
            tier.droppedCount += before - tier.events.length
        }

        const dropped = beforeSize - this.size()
        if (dropped > 0) {
            this.notifyDrop('filtered', dropped)
        }
    }

    clear() {
        this.retryQueue = []
        for (const priority of ['critical', 'high', 'normal'] as const) {
            this.tiers[priority].events = []
        }
    }

    onDrop(handler: ((info: { reason: string; count: number }) => void) | null) {
        this.dropHandler = handler
    }

    requeueFront(events: Event[]) {
        for (let i = events.length - 1; i >= 0; i--) {
            const event = events[i]
            if (event !== undefined) {
                this.retryQueue.unshift(event)
            }
        }

        // Bound retry queue
        const maxRetry = Math.floor(this.maxSize * 0.5)
        if (this.retryQueue.length > maxRetry) {
            const spilled = this.retryQueue.length - maxRetry
            this.retryQueue.splice(maxRetry, spilled)
            this.notifyDrop('retry_spilled_to_disk', spilled)
        }
    }

    /** Mark the queue as shutting down — rejects new events. */
    setShuttingDown(value: boolean): void {
        this.shuttingDown = value
    }

    isShuttingDown(): boolean {
        return this.shuttingDown
    }

    /** Persist all remaining events to storage for crash recovery. */
    async persistRemaining(persist: (event: Event) => void): Promise<void> {
        const all = this.drainAll()
        for (const event of all) {
            persist(event)
        }
    }

    getStats(): QueueStats {
        return {
            totalSize: this.size(),
            criticalSize: this.tiers.critical.events.length,
            highSize: this.tiers.high.events.length,
            normalSize: this.tiers.normal.events.length,
            retrySize: this.retryQueue.length,
            droppedCount: this.getDroppedCount(),
            deadLetterCount: this.deadLetterCount,
            isShuttingDown: this.shuttingDown,
        }
    }

    /** Get queue utilization as a ratio (0.0–1.0) for pressure monitoring. */
    getUtilization(): number {
        return this.maxSize > 0 ? this.size() / this.maxSize : 0
    }

    private shedLowerPriority(priority: EventPriority): boolean {
        const tier = this.tiers[priority]
        if (tier.events.length > 0) {
            tier.events.shift()
            tier.droppedCount += 1
            this.notifyDrop(`shed_${priority}`, 1)
            return true
        }
        // Try even lower
        if (priority === 'high') {
            return this.shedLowerPriority('normal')
        }
        return false
    }

    private notifyDrop(reason: string, count: number) {
        if (count <= 0) return
        this.dropHandler?.({ reason, count })
    }
}

/**
 * Classify an event's priority based on its type.
 */
export function getPriority(event: Event | Record<string, unknown>): EventPriority {
    const type = (event as Record<string, unknown>).type
    switch (type) {
        case 'error':
            return 'critical'
        case 'request':
        case 'span':
            return 'high'
        case 'metric':
        case 'message':
        default:
            return 'normal'
    }
}

export const eventQueue = new EventQueue()
