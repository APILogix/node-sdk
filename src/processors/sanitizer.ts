/**
 * Event sanitizer — deep PII scrubbing across all event fields.
 *
 * Redacts:
 * - Sensitive header values (authorization, cookie, api-key, etc.)
 * - PII patterns in string values (emails, credit cards, SSNs, phone numbers)
 * - Sensitive key names at any depth (password, token, secret, etc.)
 *
 * Configurable via custom patterns.
 */

import type { SDKEvent } from '../types/event.js'

// ─── Sensitive Key Detection ────────────────────────────────────────────────

const DEFAULT_SENSITIVE_KEYS = /(?:password|passwd|secret|token|api[-_]?key|api[-_]?secret|authorization|cookie|session[-_]?id|credential|private[-_]?key|access[-_]?token|refresh[-_]?token|x-api-key|x-auth-token)/i

// ─── PII Pattern Detection ──────────────────────────────────────────────────

/**
 * Factory for PII patterns — returns fresh regex instances to avoid
 * cross-call state leaks from global regex lastIndex.
 */
function createPiiPatterns(): ReadonlyArray<{ pattern: RegExp; replacement: string }> {
  return [
    // Email addresses
    { pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, replacement: '[email]' },
    // Credit card numbers (basic patterns)
    { pattern: /\b(?:\d{4}[-\s]?){3}\d{4}\b/g, replacement: '[card]' },
    // SSN-like patterns
    { pattern: /\b\d{3}-\d{2}-\d{4}\b/g, replacement: '[ssn]' },
    // Phone numbers (basic US pattern)
    { pattern: /\b(?:\+1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g, replacement: '[phone]' },
    // Bearer tokens in strings
    { pattern: /Bearer\s+[A-Za-z0-9._~+/=-]+/g, replacement: 'Bearer [REDACTED]' },
    // Authorization params in URLs
    { pattern: /(api[-_]?key|token|authorization|password|secret)=([^&\s]+)/gi, replacement: '$1=[REDACTED]' },
  ]
}

const REDACTED = '[REDACTED]'
const MAX_SANITIZE_DEPTH = 10

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Sanitize an entire event — deep-scrubs all PII and sensitive fields.
 */
export function sanitizeEvent(event: SDKEvent): SDKEvent {
  return sanitizeValue(event, 0) as SDKEvent
}

/**
 * Sanitize HTTP headers — redacts sensitive header values.
 */
export function sanitizeHeaders(
  headers: Readonly<Record<string, unknown>>
): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(headers)) {
    if (isSensitiveKey(key)) {
      sanitized[key] = REDACTED
    } else if (typeof value === 'string') {
      sanitized[key] = sanitizeString(value)
    } else {
      sanitized[key] = value
    }
  }

  return sanitized
}

// ─── Internal ───────────────────────────────────────────────────────────────

function sanitizeValue(value: unknown, depth: number): unknown {
  if (depth >= MAX_SANITIZE_DEPTH) return value

  if (typeof value === 'string') {
    return sanitizeString(value)
  }

  if (Array.isArray(value)) {
    return value.map(item => sanitizeValue(item, depth + 1))
  }

  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, nested] of Object.entries(value)) {
      if (isSensitiveKey(key)) {
        result[key] = REDACTED
      } else {
        result[key] = sanitizeValue(nested, depth + 1)
      }
    }
    return result
  }

  return value
}

function sanitizeString(value: string): string {
  let sanitized = value
  for (const { pattern, replacement } of createPiiPatterns()) {
    sanitized = sanitized.replace(pattern, replacement)
  }
  return sanitized
}

function isSensitiveKey(key: string): boolean {
  return DEFAULT_SENSITIVE_KEYS.test(key)
}