/**
 * LimitsEngine — enforces payload and resource limits from remote config.
 *
 * Backed by a complete validated `LimitsConfig`. Out-of-range snapshots are
 * rejected before this engine sees them; values are not merged or clamped.
 *
 * Responsibilities:
 *   - maxPayloadSize: reject oversized serialized payloads pre-transport.
 *   - maxSpanAttributes: bound attribute count on spans/events.
 *   - maxAttributeLength: truncate long attribute string values.
 *
 * The previous schema's `maxEventsPerSecond` rate limiter has been removed —
 * load shedding is now done by `loadShedder` and `tenantGovernor`, which
 * make smarter, pressure-aware decisions. `maxBreadcrumbs` is now an init
 * option, not part of remote config (a per-process concern, not a tenant
 * one).
 */

import type { LimitsConfig, ConfigDiff, RemoteConfigResponse } from '../types/config.js'
import type { SDKEvent } from '../types/event.js'
import { getLogger } from '../utils/logger.js'

export class LimitsEngine {
  private static instance: LimitsEngine | null = null

  private config: LimitsConfig
  private destroyed: boolean = false

  private constructor(config: LimitsConfig) {
    this.config = { ...config }
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

  // ─── Attribute Limiting ───────────────────────────────────────────────────

  /**
   * Enforce attribute limits on an event. Returns a new event (never mutates).
   */
  enforceAttributeLimits<T extends SDKEvent>(event: T): T {
    const clone = { ...event } as Record<string, unknown>

    if ('attributes' in clone && typeof clone['attributes'] === 'object' && clone['attributes'] !== null) {
      clone['attributes'] = this.trimAttributes(
        clone['attributes'] as Record<string, unknown>,
        this.config.maxSpanAttributes,
        this.config.maxAttributeLength,
      )
    }

    if ('context' in clone && typeof clone['context'] === 'object' && clone['context'] !== null) {
      clone['context'] = this.trimAttributes(
        clone['context'] as Record<string, unknown>,
        this.config.maxSpanAttributes,
        this.config.maxAttributeLength,
      )
    }

    if ('tags' in clone && typeof clone['tags'] === 'object' && clone['tags'] !== null) {
      clone['tags'] = this.trimAttributes(
        clone['tags'] as Record<string, unknown>,
        this.config.maxSpanAttributes,
        this.config.maxAttributeLength,
      )
    }

    return clone as T
  }

  // ─── Payload Size Check ───────────────────────────────────────────────────

  /** Returns true if the payload is within the configured size limit. */
  checkPayloadSize(serializedBytes: number): boolean {
    if (serializedBytes > this.config.maxPayloadSize) {
      getLogger().warn(
        '[LimitsEngine] Payload size exceeds configured limit',
      )
      return false
    }
    return true
  }

  /** Maximum spans allowed in a single trace. */
  getMaxSpansPerTrace(): number {
    return this.config.maxSpansPerTrace
  }

  // ─── Config Change ────────────────────────────────────────────────────────

  handleConfigChange(_diff: ConfigDiff, newConfig: Readonly<RemoteConfigResponse>): void {
    if (this.destroyed) return
    this.config = { ...newConfig.limits }
    getLogger().info('[LimitsEngine] Limits updated')
  }

  getConfig(): Readonly<LimitsConfig> {
    return { ...this.config }
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  private trimAttributes(
    attrs: Record<string, unknown>,
    maxCount: number,
    maxLength: number,
  ): Record<string, unknown> {
    const keys = Object.keys(attrs)

    if (keys.length <= maxCount && !keys.some(k => this.needsTruncation(attrs[k], maxLength))) {
      return attrs
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
