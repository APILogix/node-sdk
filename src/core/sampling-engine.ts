/**
 * SamplingEngine — deterministic, FNV-1a hash-based sampling.
 *
 * Replaces random Math.random() sampling with deterministic decisions:
 *   - Same traceId → same decision across all SDK instances (consistent
 *     sampling), so a downstream service either has the same span as its
 *     caller or it has none.
 *   - Per-route overrides are now per-event-type. The wire schema looks
 *     like: `routes: { "/health": { traces: 0, requests: 0 }, ... }`. A
 *     missing event-type key inside a route falls through to the global
 *     rate. A rate of 0 effectively replaces the old `ignoredRoutes` list.
 *   - Hot-swappable via config refresh — no SDK restart.
 *
 * Algorithm:
 *   1. FNV-1a 32-bit hash of the id.
 *   2. Normalize to [0.0, 1.0) by dividing by 2^32.
 *   3. Compare against the rate for the event type (route-overridden if any).
 */

import type { SamplingConfig, ConfigDiff, RemoteConfigResponse, RouteSamplingRates } from '../types/config.js'
import { getLogger } from '../utils/logger.js'
import { adaptivePressure } from '../utils/adaptive-pressure.js'

export type SamplingEventType =
  | 'traces'
  | 'requests'
  | 'spans'
  | 'errors'
  | 'messages'
  | 'profiles'
  | 'metrics'
  | 'logs'
  | 'events'
  | 'crons'

const SAMPLING_EVENT_TYPES = [
  'traces', 'requests', 'spans', 'errors', 'messages', 'profiles',
  'metrics', 'logs', 'events', 'crons',
] as const

export interface SamplingEngineOptions {
  readonly adaptive?: boolean | undefined
}

export type SamplingDecision = {
  readonly sampled: boolean
  readonly rate: number
  readonly reason: 'global_rate' | 'route_override' | 'always_sample' | 'always_drop' | 'adaptive_pressure'
}

export class SamplingEngine {
  private static instance: SamplingEngine | null = null

  private config: SamplingConfig
  private adaptive: boolean = false
  private destroyed: boolean = false

  private constructor(config: SamplingConfig, options?: SamplingEngineOptions) {
    this.config = { ...config }
    this.adaptive = options?.adaptive ?? false
  }

  static initialize(config: SamplingConfig, options?: SamplingEngineOptions): SamplingEngine {
    if (SamplingEngine.instance) {
      SamplingEngine.instance.destroy()
    }
    SamplingEngine.instance = new SamplingEngine(config, options)
    return SamplingEngine.instance
  }

  setAdaptive(enabled: boolean): void {
    this.adaptive = enabled
  }

  isAdaptive(): boolean {
    return this.adaptive
  }

  static getInstance(): SamplingEngine | null {
    return SamplingEngine.instance
  }

  // ─── Sampling Decision API ────────────────────────────────────────────────

  shouldSampleTrace(traceId: string, route?: string): SamplingDecision {
    return this.decide(traceId, 'traces', route)
  }

  shouldSampleRequest(requestId: string, route?: string): SamplingDecision {
    return this.decide(requestId, 'requests', route)
  }

  shouldSampleSpan(spanId: string, route?: string): SamplingDecision {
    return this.decide(spanId, 'spans', route)
  }

  shouldSampleError(eventId: string, route?: string): SamplingDecision {
    return this.decide(eventId, 'errors', route)
  }

  shouldSampleMessage(messageId: string, route?: string): SamplingDecision {
    return this.decide(messageId, 'messages', route)
  }

  shouldSampleProfile(traceId: string, route?: string): SamplingDecision {
    return this.decide(traceId, 'profiles', route)
  }

  shouldSampleMetric(metricId: string, route?: string): SamplingDecision {
    return this.decide(metricId, 'metrics', route)
  }

  shouldSampleLog(logId: string, route?: string): SamplingDecision {
    return this.decide(logId, 'logs', route)
  }

  shouldSampleEvent(eventId: string, route?: string): SamplingDecision {
    return this.decide(eventId, 'events', route)
  }

  shouldSampleCron(cronId: string, route?: string): SamplingDecision {
    return this.decide(cronId, 'crons', route)
  }

  // ─── Config Change ────────────────────────────────────────────────────────

  handleConfigChange(_diff: ConfigDiff, newConfig: Readonly<RemoteConfigResponse>): void {
    if (this.destroyed) return

    const newSampling = newConfig.sampling
    const old = this.config
    if (SAMPLING_EVENT_TYPES.some(key => old[key] !== newSampling[key])) {
      getLogger().info(
        '[SamplingEngine] Rates updated',
        Object.fromEntries(SAMPLING_EVENT_TYPES.map(key => [key, newSampling[key]])),
      )
    }

    this.config = { ...newSampling }
    if (newSampling?.adaptive !== undefined) {
      this.adaptive = newSampling.adaptive
    } else if (newConfig?.features?.adaptiveSampling !== undefined) {
      this.adaptive = newConfig.features.adaptiveSampling
    }
  }

  getConfig(): Readonly<SamplingConfig> {
    return { ...this.config }
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  private decide(id: string, eventType: SamplingEventType, route?: string): SamplingDecision {
    // 1. Per-route override (longest prefix match) — applies to all event types.
    if (route) {
      const routeRates = this.findRouteRates(route)
      if (routeRates) {
        const routeRate = routeRates[eventType]
        if (routeRate !== undefined) {
          return this.evaluate(id, routeRate, 'route_override', eventType)
        }
      }
    }

    // 2. Fall through to the global rate.
    const rate = this.config[eventType]
    return this.evaluate(id, rate, 'global_rate', eventType)
  }

  private evaluate(
    id: string,
    rate: number,
    reason: 'global_rate' | 'route_override',
    eventType?: SamplingEventType,
  ): SamplingDecision {
    if (rate <= 0) return { sampled: false, rate: 0, reason: 'always_drop' }

    let effectiveRate = rate
    let effectiveReason: 'global_rate' | 'route_override' | 'adaptive_pressure' = reason

    // Dynamic adaptive sampling: when enabled, dynamically scale non-error high-throughput rates under system pressure
    if (this.adaptive && eventType !== 'errors') {
      const state = adaptivePressure.getState()
      if (state === 'CRITICAL') {
        effectiveRate = Math.min(rate, 0.10)
        effectiveReason = 'adaptive_pressure'
      } else if (state === 'PRESSURED') {
        effectiveRate = Math.min(rate, rate * 0.50)
        effectiveReason = 'adaptive_pressure'
      } else if (state === 'ELEVATED') {
        effectiveRate = Math.min(rate, rate * 0.80)
        effectiveReason = 'adaptive_pressure'
      }
    }

    if (effectiveRate <= 0) return { sampled: false, rate: 0, reason: 'always_drop' }
    if (effectiveRate >= 1 && effectiveReason !== 'adaptive_pressure') {
      return { sampled: true, rate: 1, reason: 'always_sample' }
    }

    const hash = SamplingEngine.fnv1a32(id)
    const normalized = hash / 0x100000000
    return {
      sampled: normalized < effectiveRate,
      rate: effectiveRate,
      reason: effectiveReason,
    }
  }

  /**
   * Find the route-specific override map by longest-prefix match.
   * Returns the matched RouteSamplingRates record, or null.
   */
  private findRouteRates(route: string): RouteSamplingRates | null {
    const routes = this.config.routes
    if (!routes || Object.keys(routes).length === 0) return null

    let bestMatch: string | null = null
    let bestLength = 0

    for (const pattern of Object.keys(routes)) {
      if (route.startsWith(pattern) && pattern.length > bestLength) {
        bestMatch = pattern
        bestLength = pattern.length
      }
    }

    return bestMatch !== null ? routes[bestMatch] ?? null : null
  }

  /**
   * FNV-1a 32-bit hash. Deterministic and fast.
   */
  static fnv1a32(input: string): number {
    let hash = 0x811c9dc5
    for (let i = 0; i < input.length; i++) {
      hash ^= input.charCodeAt(i)
      hash = Math.imul(hash, 0x01000193)
    }
    return hash >>> 0
  }

  destroy(): void {
    this.destroyed = true
    SamplingEngine.instance = null
  }

  static reset(): void {
    if (SamplingEngine.instance) {
      SamplingEngine.instance.destroy()
    }
  }
}
