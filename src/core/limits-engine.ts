/**
 * LimitsEngine — enforces payload and resource limits from remote config.
 *
 * Responsibilities:
 * - maxPayloadSize: Reject payloads exceeding limit before serialization.
 * - maxAttributesPerEvent: Trim excess attributes.
 * - maxAttributeLength: Truncate long attribute values.
 * - maxBreadcrumbs: Cap breadcrumb ring buffer.
 * - maxEventsPerSecond: Token-bucket rate limiter.
 * - maxMemoryUsageMb / maxCpuOverheadPercent: Resource monitors (advisory, log warnings).
 *
 * All enforcement is pre-transport — events are shaped before entering the queue.
 */

import type { LimitsConfig, ConfigDiff, RemoteConfigResponse } from '../types/config.js'
import type { SDKEvent } from '../types/event.js'
import { getLogger } from '../utils/logger.js'

export class LimitsEngine {
  private static instance: LimitsEngine | null = null

  private config: LimitsConfig
  private destroyed: boolean = false

  // Token bucket for rate limiting
  private tokenBucket: number
  private lastRefillTime: number
  private eventsDropped: number = 0

  private constructor(config: LimitsConfig) {
    this.config = { ...config }
    this.tokenBucket = config.maxEventsPerSecond
    this.lastRefillTime = Date.now()
  }

  static initialize(config: LimitsConfig): LimitsEngine {
    if (LimitsEngine.instance) {
      LimitsEngine.instance.destroy()
    }
    LimitsEngine.instance = new LimitsEngine(config)
    return LimitsEngine.instance
  }

  static getInstance(): LimitsEngine | null {
    return LimitsEngine.instance
  }

  // ─── Rate Limiting ────────────────────────────────────────────────────────

  /**
   * Check if an event can be admitted (token bucket).
   * Returns true if admitted, false if rate-limited.
   */
  admitEvent(): boolean {
    this.refillTokens()

    if (this.tokenBucket >= 1) {
      this.tokenBucket -= 1
      return true
    }

    this.eventsDropped++
    if (this.eventsDropped % 100 === 1) {
      getLogger().warn(
        `[LimitsEngine] Rate limited — ${this.eventsDropped} events dropped (limit: ${this.config.maxEventsPerSecond}/s)`
      )
    }

    return false
  }

  // ─── Attribute Limiting ───────────────────────────────────────────────────

  /**
   * Enforce attribute limits on an event.
   * Trims excess attributes and truncates long values.
   * Returns a new event (does not mutate the input).
   */
  enforceAttributeLimits<T extends SDKEvent>(event: T): T {
    const clone = { ...event } as Record<string, unknown>

    // Enforce maxAttributesPerEvent on 'attributes' field (spans)
    if ('attributes' in clone && typeof clone['attributes'] === 'object' && clone['attributes'] !== null) {
      clone['attributes'] = this.trimAttributes(
        clone['attributes'] as Record<string, unknown>,
        this.config.maxAttributesPerEvent,
        this.config.maxAttributeLength
      )
    }

    // Enforce on 'context' field (errors)
    if ('context' in clone && typeof clone['context'] === 'object' && clone['context'] !== null) {
      clone['context'] = this.trimAttributes(
        clone['context'] as Record<string, unknown>,
        this.config.maxAttributesPerEvent,
        this.config.maxAttributeLength
      )
    }

    // Enforce on 'tags' field (metrics)
    if ('tags' in clone && typeof clone['tags'] === 'object' && clone['tags'] !== null) {
      clone['tags'] = this.trimAttributes(
        clone['tags'] as Record<string, unknown>,
        this.config.maxAttributesPerEvent,
        this.config.maxAttributeLength
      )
    }

    return clone as T
  }

  // ─── Payload Size Check ───────────────────────────────────────────────────

  /**
   * Check if a serialized payload exceeds the max payload size.
   * Returns true if the payload is within limits.
   */
  checkPayloadSize(serializedBytes: number): boolean {
    if (serializedBytes > this.config.maxPayloadSize) {
      getLogger().warn(
        `[LimitsEngine] Payload size ${serializedBytes} exceeds limit ${this.config.maxPayloadSize}`
      )
      return false
    }
    return true
  }

  // ─── Breadcrumb Cap ───────────────────────────────────────────────────────

  /** Get the maximum breadcrumbs allowed. */
  getMaxBreadcrumbs(): number {
    return this.config.maxBreadcrumbs
  }

  // ─── Config Change ────────────────────────────────────────────────────────

  /** Handle config change — hot-swap limits. */
  handleConfigChange(_diff: ConfigDiff, newConfig: Readonly<RemoteConfigResponse>): void {
    if (this.destroyed) return

    const newLimits = newConfig.limits
    const logger = getLogger()

    if (this.config.maxEventsPerSecond !== newLimits.maxEventsPerSecond) {
      logger.info(`[LimitsEngine] Rate limit updated: ${newLimits.maxEventsPerSecond}/s`)
    }

    this.config = { ...newLimits }
    this.tokenBucket = Math.min(this.tokenBucket, newLimits.maxEventsPerSecond)
  }

  /** Get current config. */
  getConfig(): Readonly<LimitsConfig> {
    return { ...this.config }
  }

  /** Get drop stats. */
  getDroppedCount(): number {
    return this.eventsDropped
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  private refillTokens(): void {
    const now = Date.now()
    const elapsed = (now - this.lastRefillTime) / 1000
    this.lastRefillTime = now

    this.tokenBucket = Math.min(
      this.config.maxEventsPerSecond,
      this.tokenBucket + elapsed * this.config.maxEventsPerSecond
    )
  }

  private trimAttributes(
    attrs: Record<string, unknown>,
    maxCount: number,
    maxLength: number
  ): Record<string, unknown> {
    const keys = Object.keys(attrs)

    if (keys.length <= maxCount && !keys.some(k => this.needsTruncation(attrs[k], maxLength))) {
      return attrs // Fast path: no changes needed
    }

    const result: Record<string, unknown> = {}
    let count = 0

    for (const key of keys) {
      if (count >= maxCount) {
        getLogger().warn(`[LimitsEngine] Trimmed ${keys.length - maxCount} attributes`)
        break
      }
      result[key] = this.truncateValue(attrs[key], maxLength)
      count++
    }

    return result
  }

  private needsTruncation(value: unknown, maxLength: number): boolean {
    return typeof value === 'string' && value.length > maxLength
  }

  private truncateValue(value: unknown, maxLength: number): unknown {
    if (typeof value === 'string' && value.length > maxLength) {
      return value.slice(0, maxLength) + '…'
    }
    return value
  }

  destroy(): void {
    this.destroyed = true
    LimitsEngine.instance = null
  }

  static reset(): void {
    if (LimitsEngine.instance) {
      LimitsEngine.instance.destroy()
    }
  }
}
