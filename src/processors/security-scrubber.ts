/**
 * SecurityScrubber — enforces privacy.scrubbing and privacy.piiDetection config.
 *
 * Pre-transport processor that:
 * 1. Scrubs sensitive headers (authorization, cookie, etc.)
 * 2. Scrubs sensitive body fields (password, token, secret, etc.)
 * 3. Scrubs sensitive query parameters (uses the same `fields` list as bodies)
 * 4. Detects and masks PII (emails, phones, IPs)
 *
 * All scrubbing is done on the event BEFORE it enters the transport queue.
 * The scrubber returns a new event — it never mutates the original.
 */

import type { PrivacyConfig, ScrubbingConfig, PiiDetectionConfig, ConfigDiff, RemoteConfigResponse } from '../types/config.js'
import type { SDKEvent } from '../types/event.js'
import { getLogger } from '../utils/logger.js'

const REDACTED = '[Redacted]'

export class SecurityScrubber {
  private static instance: SecurityScrubber | null = null

  private scrubbingConfig: ScrubbingConfig
  private piiConfig: PiiDetectionConfig
  private destroyed: boolean = false
  private hasScrubRules: boolean = false

  // Pre-compiled sets for O(1) lookups. Headers and the unified `fields`
  // list each get their own lowercased Set so callers can avoid recomputing
  // them on every event.
  private sensitiveHeaders: Set<string>
  private sensitiveFields: Set<string>

  // PII patterns
  private static readonly EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g
  private static readonly PHONE_PATTERN = /(\+?1?\s*[-.\s]?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4})/g
  private static readonly IPV4_PATTERN = /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g

  private constructor(config: PrivacyConfig) {
    this.scrubbingConfig = { ...config.scrubbing }
    this.piiConfig = { ...config.piiDetection }

    this.sensitiveHeaders = new Set(config.scrubbing.headers.map((h: string) => h.toLowerCase()))
    this.sensitiveFields = new Set(config.scrubbing.fields.map((f: string) => f.toLowerCase()))
    this.updateHasScrubRules()
  }

  private updateHasScrubRules() {
    this.hasScrubRules = !!(
      (this.scrubbingConfig.enabled && (this.sensitiveHeaders.size > 0 || this.sensitiveFields.size > 0)) ||
      (this.piiConfig.enabled && (this.piiConfig.maskEmails || this.piiConfig.maskPhones || this.piiConfig.maskIPs))
    )
  }

  static initialize(config: PrivacyConfig): SecurityScrubber {
    if (SecurityScrubber.instance) {
      SecurityScrubber.instance.destroy()
    }
    SecurityScrubber.instance = new SecurityScrubber(config)
    return SecurityScrubber.instance
  }

  static getInstance(): SecurityScrubber | null {
    return SecurityScrubber.instance
  }

  /**
   * Scrub an event. Returns a new event with sensitive data redacted.
   * Never mutates the original event. Never throws.
   */
  scrub<T extends SDKEvent>(event: T): T {
    if (this.destroyed || !this.hasScrubRules) return event

    try {
      const clone = { ...event } as Record<string, unknown>

      const hasHeaderRules = this.scrubbingConfig.enabled && this.sensitiveHeaders.size > 0
      const hasFieldRules = this.scrubbingConfig.enabled && this.sensitiveFields.size > 0
      const hasPiiRules = this.piiConfig.enabled && (this.piiConfig.maskEmails || this.piiConfig.maskPhones || this.piiConfig.maskIPs)
      const needsDeepScrub = hasFieldRules || hasPiiRules

      // Shallow clone objects that we'll mutate — but only when we actually
      // have rules that require inspecting them. Previously these clones
      // ran unconditionally, wasting CPU and allocations for large payloads
      // when only header scrubbing was configured.
      if (hasHeaderRules && 'headers' in clone && typeof clone['headers'] === 'object' && clone['headers'] !== null) {
        clone['headers'] = { ...(clone['headers'] as Record<string, unknown>) }
      }
      if (hasFieldRules && 'query' in clone && typeof clone['query'] === 'object' && clone['query'] !== null) {
        clone['query'] = { ...(clone['query'] as Record<string, unknown>) }
      }
      if (needsDeepScrub) {
        if ('context' in clone && typeof clone['context'] === 'object' && clone['context'] !== null) {
          clone['context'] = { ...(clone['context'] as Record<string, unknown>) }
        }
        if ('attributes' in clone && typeof clone['attributes'] === 'object' && clone['attributes'] !== null) {
          clone['attributes'] = { ...(clone['attributes'] as Record<string, unknown>) }
        }
        if ('body' in clone && typeof clone['body'] === 'object' && clone['body'] !== null && !Array.isArray(clone['body'])) {
          clone['body'] = { ...(clone['body'] as Record<string, unknown>) }
        }
      }

      // Scrub headers
      if (hasHeaderRules && 'headers' in clone && typeof clone['headers'] === 'object' && clone['headers'] !== null) {
        clone['headers'] = this.scrubHeaders(clone['headers'] as Record<string, unknown>)
      }

      // Scrub query params
      if (hasFieldRules && 'query' in clone && typeof clone['query'] === 'object' && clone['query'] !== null) {
        clone['query'] = this.scrubQueryParams(clone['query'] as Record<string, unknown>)
      }

      // Scrub URL query string
      if (hasFieldRules && 'url' in clone && typeof clone['url'] === 'string') {
        clone['url'] = this.scrubUrlQueryString(clone['url'] as string)
      }

      // Scrub body fields in context/attributes/body — only when there
      // are actually sensitive field names to check. This avoids the
      // recursive traversal (up to depth 10) for every event when only
      // header scrubbing is configured.
      if (hasFieldRules) {
        if ('context' in clone && typeof clone['context'] === 'object' && clone['context'] !== null) {
          clone['context'] = this.scrubBodyFields(clone['context'] as Record<string, unknown>)
        }
        if ('attributes' in clone && typeof clone['attributes'] === 'object' && clone['attributes'] !== null) {
          clone['attributes'] = this.scrubBodyFields(clone['attributes'] as Record<string, unknown>)
        }
        if ('body' in clone && typeof clone['body'] === 'object' && clone['body'] !== null && !Array.isArray(clone['body'])) {
          clone['body'] = this.scrubBodyFields(clone['body'] as Record<string, unknown>)
        }
      }

      // PII detection on string fields
      if (hasPiiRules) {
        this.scrubPiiInObject(clone)
      }

      return clone as T
    } catch (err) {
      getLogger().warn(
        `[SecurityScrubber] Error during scrubbing: ${err instanceof Error ? err.message : String(err)}`
      )
      return event // Return original on error
    }
  }

  scrubBatch<T extends SDKEvent>(events: T[]): T[] {
    if (this.destroyed || !this.hasScrubRules) return events
    return events.map(e => this.scrub(e))
  }

  /** Handle config change — hot-swap privacy config. */
  handleConfigChange(_diff: ConfigDiff, newConfig: Readonly<RemoteConfigResponse>): void {
    if (this.destroyed) return

    const newPrivacy = newConfig.privacy
    this.scrubbingConfig = { ...newPrivacy.scrubbing }
    this.piiConfig = { ...newPrivacy.piiDetection }

    this.sensitiveHeaders = new Set(newPrivacy.scrubbing.headers.map((h: string) => h.toLowerCase()))
    this.sensitiveFields = new Set(newPrivacy.scrubbing.fields.map((f: string) => f.toLowerCase()))
    this.updateHasScrubRules()

    getLogger().info('[SecurityScrubber] Config updated')
  }

  // ─── Private Scrubbing Methods ────────────────────────────────────────────

  /**
   * Object keys we refuse to copy to scrubbed output. Even though the input
   * arrives via structuredClone (which doesn't preserve the magic
   * `__proto__` accessor), defense-in-depth: a future serialization
   * format change or a hand-crafted payload could include these as plain
   * own properties. Skipping them prevents prototype pollution from
   * downstream consumers that re-merge our output via Object.assign.
   */
  private static readonly DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

  private scrubHeaders(headers: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = Object.create(null)
    for (const [key, value] of Object.entries(headers)) {
      if (SecurityScrubber.DANGEROUS_KEYS.has(key)) continue
      result[key] = this.sensitiveHeaders.has(key.toLowerCase()) ? REDACTED : value
    }
    return result
  }

  private scrubQueryParams(query: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = Object.create(null)
    for (const [key, value] of Object.entries(query)) {
      if (SecurityScrubber.DANGEROUS_KEYS.has(key)) continue
      result[key] = this.sensitiveFields.has(key.toLowerCase()) ? REDACTED : value
    }
    return result
  }

  private scrubUrlQueryString(url: string): string {
    try {
      const parsed = new URL(url, 'http://localhost')
      let changed = false

      for (const param of this.sensitiveFields) {
        if (parsed.searchParams.has(param)) {
          parsed.searchParams.set(param, REDACTED)
          changed = true
        }
      }

      return changed ? parsed.toString() : url
    } catch {
      return url
    }
  }

  private scrubBodyFields(obj: Record<string, unknown>, depth: number = 0): Record<string, unknown> {
    if (depth > 10) return obj // Prevent infinite recursion

    const result: Record<string, unknown> = Object.create(null)
    for (const [key, value] of Object.entries(obj)) {
      if (SecurityScrubber.DANGEROUS_KEYS.has(key)) continue
      if (this.sensitiveFields.has(key.toLowerCase())) {
        result[key] = REDACTED
      } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        result[key] = this.scrubBodyFields(value as Record<string, unknown>, depth + 1)
      } else {
        result[key] = value
      }
    }
    return result
  }

  private scrubPiiInObject(obj: Record<string, unknown>, depth: number = 0): void {
    if (depth > 10) return

    for (const key of Object.keys(obj)) {
      if (SecurityScrubber.DANGEROUS_KEYS.has(key)) continue
      const value = obj[key]
      if (typeof value === 'string') {
        obj[key] = this.scrubPiiInString(value)
      } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        this.scrubPiiInObject(value as Record<string, unknown>, depth + 1)
      }
    }
  }

  private scrubPiiInString(str: string): string {
    let result = str

    if (this.piiConfig.maskEmails) {
      result = result.replace(SecurityScrubber.EMAIL_PATTERN, '[email]')
    }
    if (this.piiConfig.maskPhones) {
      result = result.replace(SecurityScrubber.PHONE_PATTERN, '[phone]')
    }
    if (this.piiConfig.maskIPs) {
      result = result.replace(SecurityScrubber.IPV4_PATTERN, '[ip]')
    }

    return result
  }

  destroy(): void {
    this.destroyed = true
    SecurityScrubber.instance = null
  }

  static reset(): void {
    if (SecurityScrubber.instance) {
      SecurityScrubber.instance.destroy()
    }
  }
}
