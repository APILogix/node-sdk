/**
 * API Payload Scrubber — enterprise-grade PII and sensitive data redaction.
 *
 * Provides configurable redaction for:
 * - Specific API payload fields (headers, query parameters, request/response bodies)
 * - Deep object scrubbing via recursive property traversal
 * - String sanitization using PII detection patterns
 */

import type { SDKEvent, RequestEvent, SpanEvent } from '../types/event.js'

const DEFAULT_SENSITIVE_KEYS_PATTERN = /(?:password|passwd|secret|token|api[-_]?key|api[-_]?secret|authorization|cookie|session[-_]?id|credential|private[-_]?key|access[-_]?token|refresh[-_]?token|x-api-key|x-auth-token)/i
const DEFAULT_SENSITIVE_HEADERS = ['authorization', 'cookie', 'set-cookie', 'x-api-key', 'proxy-authorization']

function createPiiPatterns(): ReadonlyArray<{ pattern: RegExp; replacement: string }> {
  return [
    { pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, replacement: '[email]' },
    { pattern: /\b(?:\d{4}[-\s]?){3}\d{4}\b/g, replacement: '[card]' },
    { pattern: /\b\d{3}-\d{2}-\d{4}\b/g, replacement: '[ssn]' },
    { pattern: /\b(?:\+1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g, replacement: '[phone]' },
    { pattern: /Bearer\s+[A-Za-z0-9._~+/=-]+/g, replacement: 'Bearer [REDACTED]' },
    { pattern: /(api[-_]?key|token|authorization|password|secret)=([^&\s]+)/gi, replacement: '$1=[REDACTED]' },
  ]
}

const REDACTED = '[REDACTED]'
const MAX_SANITIZE_DEPTH = 10
const MAX_OBJECT_KEYS = 200

export interface ScrubberConfig {
  sensitiveHeaders?: string[]
  sensitiveKeys?: string[]
  redactRequestBody?: boolean
  redactResponseBody?: boolean
}

class ApiPayloadScrubber {
  private customHeaders: Set<string> = new Set()
  private customKeysPattern: RegExp | null = null
  private redactRequestBody: boolean = false
  private redactResponseBody: boolean = false

  configure(config: ScrubberConfig = {}): void {
    if (config.sensitiveHeaders) {
      this.customHeaders = new Set(config.sensitiveHeaders.map(h => h.toLowerCase()))
    }
    if (config.sensitiveKeys && config.sensitiveKeys.length > 0) {
      const escapedKeys = config.sensitiveKeys.map(k => k.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&'))
      this.customKeysPattern = new RegExp(`(?:${escapedKeys.join('|')})`, 'i')
    }
    this.redactRequestBody = config.redactRequestBody ?? false
    this.redactResponseBody = config.redactResponseBody ?? false
  }

  /**
   * Main entry point for the event pipeline.
   * Deep-scrubs PII and explicitly governs API payloads (headers, query, bodies).
   */
  sanitizeEvent(event: SDKEvent): SDKEvent {
    // 1. Explicit API Payload Governance
    if (event.type === 'request') {
      this.scrubRequestEvent(event as RequestEvent)
    } else if (event.type === 'span') {
      this.scrubSpanEvent(event as SpanEvent)
    }

    // 2. Deep Object Scrubbing (fallback for context/extra data)
    return this.sanitizeValue(event, 0) as SDKEvent
  }

  private scrubRequestEvent(event: RequestEvent): void {
    if (event.headers) {
      (event as any).headers = this.sanitizeHeaders(event.headers)
    }
    if (this.redactRequestBody) {
      if ((event as any).body) {
        (event as any).body = REDACTED
      }
      if (event.bodySize !== undefined) {
        // Redacting body content, but preserving bodySize metric is usually okay.
        // If compliance requires hiding the size of request payload, we would redact it too.
      }
    }
  }

  private scrubSpanEvent(event: SpanEvent): void {
    if (!event.attributes) return
    const attrs = event.attributes as Record<string, unknown>
    
    // OTel HTTP semantic conventions
    if (this.redactRequestBody && attrs['http.request.body']) {
      attrs['http.request.body'] = REDACTED
    }
    if (this.redactResponseBody && attrs['http.response.body']) {
      attrs['http.response.body'] = REDACTED
    }

    // Scrub header attributes (e.g., http.request.header.authorization)
    for (const key of Object.keys(attrs)) {
      if (key.startsWith('http.request.header.') || key.startsWith('http.response.header.')) {
        const headerName = key.split('.').pop() || ''
        if (this.isSensitiveHeader(headerName)) {
          attrs[key] = REDACTED
        }
      }
    }
  }

  /**
   * Sanitize HTTP headers explicitly.
   */
  sanitizeHeaders(headers: Readonly<Record<string, unknown>>): Record<string, unknown> {
    const sanitized: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(headers)) {
      if (this.isSensitiveHeader(key) || this.isSensitiveKey(key)) {
        sanitized[key] = REDACTED
      } else if (typeof value === 'string') {
        sanitized[key] = this.sanitizeString(value)
      } else {
        sanitized[key] = value
      }
    }
    return sanitized
  }

  private isSensitiveHeader(headerName: string): boolean {
    const normalized = headerName.toLowerCase()
    return DEFAULT_SENSITIVE_HEADERS.includes(normalized) || this.customHeaders.has(normalized)
  }

  private isSensitiveKey(key: string): boolean {
    if (this.customKeysPattern && this.customKeysPattern.test(key)) return true
    return DEFAULT_SENSITIVE_KEYS_PATTERN.test(key)
  }

  private sanitizeValue(root: unknown, _depth: number): unknown {
    if (root === null || root === undefined) return root
    if (typeof root === 'string') return this.sanitizeString(root)
    if (typeof root !== 'object') return root
    const seen = new WeakSet<object>()
    return this.sanitizeObject(root, 0, seen)
  }

  private sanitizeObject(value: unknown, depth: number, seen: WeakSet<object>): unknown {
    if (depth >= MAX_SANITIZE_DEPTH) return value
    if (value === null || value === undefined) return value
    if (typeof value === 'string') return this.sanitizeString(value)
    if (typeof value !== 'object') return value

    const obj = value as object
    if (seen.has(obj)) return '[Circular]'
    seen.add(obj)

    try {
      if (Array.isArray(value)) {
        const result: unknown[] = []
        const limit = Math.min(value.length, MAX_OBJECT_KEYS)
        for (let i = 0; i < limit; i++) {
          result.push(this.sanitizeObject(value[i], depth + 1, seen))
        }
        if (value.length > MAX_OBJECT_KEYS) {
          result.push(`[truncated: ${value.length - MAX_OBJECT_KEYS} more items]`)
        }
        return result
      }

      const result: Record<string, unknown> = {}
      const entries = Object.entries(value)
      const limit = Math.min(entries.length, MAX_OBJECT_KEYS)
      for (let i = 0; i < limit; i++) {
        const entry = entries[i]
        if (!entry) continue
        const [key, nested] = entry
        if (this.isSensitiveKey(key)) {
          result[key] = REDACTED
        } else {
          result[key] = this.sanitizeObject(nested, depth + 1, seen)
        }
      }
      if (entries.length > MAX_OBJECT_KEYS) {
        result['__truncated'] = `${entries.length - MAX_OBJECT_KEYS} more keys`
      }
      return result
    } finally {
      seen.delete(obj)
    }
  }

  private sanitizeString(value: string): string {
    let sanitized = value
    for (const { pattern, replacement } of createPiiPatterns()) {
      sanitized = sanitized.replace(pattern, replacement)
    }
    return sanitized
  }
}

export const apiPayloadScrubber = new ApiPayloadScrubber()

// Backward compatibility exports
export function sanitizeEvent(event: SDKEvent): SDKEvent {
  return apiPayloadScrubber.sanitizeEvent(event)
}

export function sanitizeHeaders(headers: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return apiPayloadScrubber.sanitizeHeaders(headers)
}