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
import { isIP } from 'node:net'

const REDACTED = '[Redacted]'
const SYSTEM_ID_KEYS = new Set(['traceId', 'spanId', 'parentSpanId', 'eventId'])

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
  private static readonly EMAIL_PATTERN = /(?<![a-zA-Z0-9._%+-])[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g
  private static readonly PHONE_PATTERN = /(?<![a-zA-Z0-9])(\+?1?\s*[-.\s]?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4})(?![a-zA-Z0-9])/g
  private static readonly IPV4_PATTERN = /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g
  private static readonly BRACKETED_IPV6_PATTERN = /\[([0-9A-Fa-f:.]+)(%[0-9A-Za-z_.-]+)?\](?::\d{1,5})?/g
  private static readonly IPV6_CANDIDATE_PATTERN = /(?<![0-9A-Za-z])([0-9A-Fa-f:.]+(?:%[0-9A-Za-z_.-]+)?)(?![0-9A-Za-z])/g

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
      const needsDeepScrub = hasFieldRules || hasHeaderRules || hasPiiRules

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

      // Deep-copy and scrub every payload section, including scope-provided
      // `extra`, `contexts`, `rootSpan`, and embedded `spans`. This prevents sensitive keys from escaping
      // merely because a new event field was added, and preserves caller
      // immutability for nested objects/arrays.
      if (needsDeepScrub) {
        for (const [key, value] of Object.entries(clone)) {
          if (key === 'metadata' || SYSTEM_ID_KEYS.has(key) || SecurityScrubber.DANGEROUS_KEYS.has(key)) {
            if (SecurityScrubber.DANGEROUS_KEYS.has(key)) delete clone[key]
            continue
          }
          clone[key] = this.scrubValue(value)
        }
      }

      return clone as T
    } catch (err) {
      getLogger().warn(
        `[SecurityScrubber] Error during scrubbing: ${err instanceof Error ? err.message : String(err)}`
      )
      return stripSensitiveSections(event)
    }
  }

  scrubBatch<T extends SDKEvent>(events: T[]): T[] {
    if (this.destroyed || !this.hasScrubRules) return events
    return events.map(e => this.scrub(e))
  }

  /**
   * Determine if a field or attribute key matches sensitive field/header rules.
   * Checks full key as well as trailing component (e.g. `http.request.header.authorization` -> `authorization`).
   */
  private isKeySensitive(rawKey: string): boolean {
    if (!this.scrubbingConfig.enabled) return false
    const key = rawKey.toLowerCase()
    if (this.sensitiveFields.has(key) || this.sensitiveHeaders.has(key)) return true

    const parts = key.split(/[\.:]/)
    const lastPart = parts[parts.length - 1]
    if (lastPart && (this.sensitiveFields.has(lastPart) || this.sensitiveHeaders.has(lastPart))) {
      return true
    }
    return false
  }

  /**
   * Scrub an arbitrary value (object, array, or string) with the active
   * field-redaction and PII rules. Used for payload sections that are not
   * part of the fixed event shape — e.g. `LogEvent.args`,
   * `ReplayEvent.events`, profile payloads, aggregated trace spans. Returns a new value; never
   * mutates the input. Never throws.
   */
  scrubValue(value: unknown, depth: number = 0): unknown {
    if (this.destroyed || !this.hasScrubRules) return value
    if (depth > 10) return REDACTED

    try {
      if (typeof value === 'string') {
        let str = value
        if (this.piiConfig.enabled) {
          str = this.scrubPiiInString(str)
        }
        if (this.scrubbingConfig.enabled) {
          str = str.replace(/Bearer\s+[A-Za-z0-9_\-\.]+/gi, 'Bearer [Redacted]')
          str = str.replace(/eyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/g, '[Redacted]')
        }
        return str
      }
      if (Array.isArray(value)) {
        return value.map(item => this.scrubValue(item, depth + 1))
      }
      if (typeof value === 'object' && value !== null) {
        const result: Record<string, unknown> = Object.create(null)
        for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
          if (SecurityScrubber.DANGEROUS_KEYS.has(key)) continue
          if (SYSTEM_ID_KEYS.has(key)) {
            result[key] = v
          } else if (this.isKeySensitive(key)) {
            result[key] = REDACTED
          } else {
            result[key] = this.scrubValue(v, depth + 1)
          }
        }
        return result
      }
      return value
    } catch {
      return REDACTED
    }
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
      } else if (typeof value === 'object' && value !== null) {
        // Arrays (e.g. LogEvent.args, ReplayEvent.events, profile nodes)
        // are traversed item-by-item; objects inside arrays are scrubbed
        // recursively. Scalars pass through untouched.
        result[key] = Array.isArray(value)
          ? value.map(item =>
              typeof item === 'object' && item !== null
                ? Array.isArray(item)
                  ? (this.scrubValue(item, depth + 1) as unknown[])
                  : this.scrubBodyFields(item as Record<string, unknown>, depth + 1)
                : item,
            )
          : this.scrubBodyFields(value as Record<string, unknown>, depth + 1)
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
      } else if (typeof value === 'object' && value !== null) {
        if (Array.isArray(value)) {
          // Copy-on-write: arrays live on a shallow clone, so scrubbing in
          // place would mutate the caller's original event. Produce a new
          // array (and shallow copies of object items) instead.
          obj[key] = this.scrubPiiInArray(value, depth + 1)
        } else {
          this.scrubPiiInObject(value as Record<string, unknown>, depth + 1)
        }
      }
    }
  }

  private scrubPiiInArray(arr: unknown[], depth: number = 0): unknown[] {
    if (depth > 10) return arr

    return arr.map(item => {
      if (typeof item === 'string') {
        return this.scrubPiiInString(item)
      }
      if (Array.isArray(item)) {
        return this.scrubPiiInArray(item, depth + 1)
      }
      if (typeof item === 'object' && item !== null) {
        const copy = { ...(item as Record<string, unknown>) }
        this.scrubPiiInObject(copy, depth + 1)
        return copy
      }
      return item
    })
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
      result = result.replace(SecurityScrubber.BRACKETED_IPV6_PATTERN, (candidate, address: string) =>
        isIP(address) === 6 ? '[ip]' : candidate,
      )
      result = result.replace(SecurityScrubber.IPV6_CANDIDATE_PATTERN, (candidate: string) => {
        const address = candidate.includes('%') ? candidate.slice(0, candidate.indexOf('%')) : candidate
        // Colon-delimited times and MAC addresses are not treated as IPs,
        // even where a permissive parser might consider them abbreviated IPv6.
        if (/^\d{1,2}:\d{2}:\d{2}$/.test(address) || /^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(address)) {
          return candidate
        }
        return isIP(address) === 6 ? '[ip]' : candidate
      })
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

function stripSensitiveSections<T extends SDKEvent>(event: T): T {
  const clone = { ...event } as Record<string, unknown>
  for (const key of [
    'headers', 'query', 'body', 'response', 'cookies', 'context', 'attributes',
    'tags', 'extra', 'contexts', 'user', 'breadcrumbs',
  ]) {
    delete clone[key]
  }
  if ('args' in clone) clone['args'] = []
  if ('events' in clone) clone['events'] = []
  if ('profile' in clone) clone['profile'] = REDACTED
  if ('stack' in clone) clone['stack'] = []
  if (typeof clone['message'] === 'string') clone['message'] = REDACTED
  if (typeof clone['url'] === 'string') clone['url'] = clone['url'].split('?')[0] ?? ''
  return clone as T
}
