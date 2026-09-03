/**
 * Adaptive Load Shedder — graceful degradation during overload.
 *
 * Classifies telemetry events by priority and sheds them based on
 * the current system pressure level from AdaptivePressureMonitor.
 *
 * Priority levels:
 *   P0 (never drop): uncaughtException, unhandledRejection, OOM
 *   P1 (drop last): errors with stack traces
 *   P2 (brownout): request events, spans
 *   P3 (drop first): messages, metrics, breadcrumbs
 *
 * Shedding behavior by pressure level:
 *   normal:   shed nothing
 *   elevated: shed nothing (warning logged)
 *   high:     shed P3 events
 *   critical: shed P3, keep a deterministic P2 sample, P0 + P1 survive
 */

import { getLogger } from '../utils/logger.js'
import { adaptivePressure, type CompositePressureLevel } from '../utils/adaptive-pressure.js'

// ─── Types ──────────────────────────────────────────────────────────────────

export type TelemetryPriority = 'p0_critical' | 'p1_error' | 'p2_request' | 'p3_low'

export interface LoadShedderStats {
    readonly droppedByPriority: Record<TelemetryPriority, number>
    readonly currentLevel: CompositePressureLevel
    readonly totalShed: number
}

const CRITICAL_P2_KEEP_RATE = 0.1

// ─── Implementation ─────────────────────────────────────────────────────────

export class LoadShedder {
    private droppedCounts: Record<TelemetryPriority, number> = {
        p0_critical: 0,
        p1_error: 0,
        p2_request: 0,
        p3_low: 0,
    }
    private totalShed = 0

    constructor(
        private readonly getPressureLevel: () => CompositePressureLevel = () => adaptivePressure.getLevel(),
    ) {}

    /**
     * Classify an event into a telemetry priority tier.
     */
    classifyEvent(event: Record<string, unknown>): TelemetryPriority {
        const type = event['type'] as string | undefined
        const mechanism = event['mechanism'] as Record<string, unknown> | undefined

        // P0: unhandled errors (crashes, OOM)
        if (type === 'error') {
            const mechanismType = mechanism?.['type'] as string | undefined
            if (
                mechanismType === 'uncaughtException' ||
                mechanismType === 'unhandledRejection' ||
                mechanismType === 'onunhandledrejection' ||
                mechanismType === 'onerror'
            ) {
                return 'p0_critical'
            }
            return 'p1_error'
        }

        // P2: requests and spans (important but sheddable)
        if (type === 'request' || type === 'span') {
            return 'p2_request'
        }

        // P3: everything else (metrics, messages, breadcrumbs)
        return 'p3_low'
    }

    /**
     * Determine if an event should be shed based on current pressure.
     * Returns true if the event should be DROPPED.
     */
    shouldShed(event: Record<string, unknown>): boolean {
        const priority = this.classifyEvent(event)
        const pressureLevel = this.getPressureLevel()

        let shed = false

        switch (pressureLevel) {
            case 'normal':
                shed = false
                break

            case 'elevated':
                // Warning only — don't shed yet
                shed = false
                break

            case 'high':
                // Shed low-priority
                shed = priority === 'p3_low'
                break

            case 'critical':
                // Low-value telemetry is dropped, but request/span telemetry
                // keeps a deterministic trickle so visibility never goes dark.
                shed = priority === 'p3_low'
                    || (priority === 'p2_request' && !keepDeterministicSample(event, CRITICAL_P2_KEEP_RATE))
                break
        }

        if (shed) {
            this.droppedCounts[priority]++
            this.totalShed++

            if (this.totalShed % 100 === 1) {
                getLogger().warn('Load shedder active — dropping telemetry', {
                    priority,
                    pressureLevel,
                    totalShed: this.totalShed,
                })
            }
        }

        return shed
    }

    getStats(): LoadShedderStats {
        return {
            droppedByPriority: { ...this.droppedCounts },
            currentLevel: this.getPressureLevel(),
            totalShed: this.totalShed,
        }
    }

    reset(): void {
        this.droppedCounts = {
            p0_critical: 0,
            p1_error: 0,
            p2_request: 0,
            p3_low: 0,
        }
        this.totalShed = 0
    }
}

// ─── Singleton ──────────────────────────────────────────────────────────────

export const loadShedder = new LoadShedder()

function keepDeterministicSample(event: Record<string, unknown>, rate: number): boolean {
    if (rate >= 1) return true
    if (rate <= 0) return false
    const key = stableEventKey(event)
    return hashToUnitInterval(key) < rate
}

function stableEventKey(event: Record<string, unknown>): string {
    for (const field of ['eventId', 'traceId', 'spanId']) {
        const value = event[field]
        if (typeof value === 'string' && value.length > 0) return value
    }
    const type = event['type']
    const timestamp = event['timestamp']
    return `${typeof type === 'string' ? type : 'unknown'}:${typeof timestamp === 'number' ? timestamp : Date.now()}`
}

function hashToUnitInterval(value: string): number {
    let hash = 0x811c9dc5
    for (let index = 0; index < value.length; index++) {
        hash ^= value.charCodeAt(index)
        hash = Math.imul(hash, 0x01000193)
    }
    return (hash >>> 0) / 0x100000000
}
