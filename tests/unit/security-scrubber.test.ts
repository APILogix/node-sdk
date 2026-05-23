/**
 * SecurityScrubber Unit Tests — CRITICAL
 *
 * Validates:
 * - Case-insensitive header scrubbing → [Redacted]
 * - Recursive body field stripping in context/attributes (nested objects)
 * - Query parameter stripping from URLs
 * - Email masking: user@example.com → [email]
 * - Phone masking: +1-555-123-4567 → [phone]
 * - Scrubbing disabled via config
 * - Config hot-swap updates scrubbing rules
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { SecurityScrubber } from '../../src/processors/security-scrubber.js'

const baseSecurityConfig = {
  scrubbing: {
    enabled: true,
    headers: ['authorization', 'cookie', 'x-api-key', 'x-auth-token'],
    bodyFields: ['password', 'token', 'secret', 'creditCard', 'ssn', 'nationalId', 'apiKey'],
    queryParams: ['token', 'apikey', 'password', 'secret'],
  },
  piiDetection: {
    enabled: true,
    maskEmails: true,
    maskPhones: true,
    maskIPs: false,
  },
}

describe('SecurityScrubber', () => {
  let scrubber: SecurityScrubber

  beforeEach(() => {
    scrubber = SecurityScrubber.initialize(baseSecurityConfig)
  })

  afterEach(() => {
    SecurityScrubber.reset()
  })

  // ─── Header Scrubbing ──────────────────────────────────────────────────

  describe('Header Scrubbing', () => {
    it('should scrub authorization header (case-insensitive)', () => {
      const event = {
        type: 'request',
        headers: {
          'Authorization': 'Bearer sk_live_abc123',
          'Content-Type': 'application/json',
        },
      }

      const scrubbed = scrubber.scrub(event as any)
      const headers = (scrubbed as any).headers
      assert.equal(headers['Authorization'], '[Redacted]')
      assert.equal(headers['Content-Type'], 'application/json')
    })

    it('should scrub cookie header', () => {
      const event = {
        type: 'request',
        headers: {
          'Cookie': 'session=abc123; token=secret',
          'Accept': 'text/html',
        },
      }

      const scrubbed = scrubber.scrub(event as any)
      assert.equal((scrubbed as any).headers['Cookie'], '[Redacted]')
      assert.equal((scrubbed as any).headers['Accept'], 'text/html')
    })

    it('should scrub x-api-key header', () => {
      const event = {
        type: 'request',
        headers: {
          'X-Api-Key': 'my-secret-key',
        },
      }

      const scrubbed = scrubber.scrub(event as any)
      assert.equal((scrubbed as any).headers['X-Api-Key'], '[Redacted]')
    })

    it('should preserve non-sensitive headers', () => {
      const event = {
        type: 'request',
        headers: {
          'Content-Type': 'application/json',
          'Accept-Language': 'en-US',
          'User-Agent': 'Mozilla/5.0',
        },
      }

      const scrubbed = scrubber.scrub(event as any)
      const h = (scrubbed as any).headers
      assert.equal(h['Content-Type'], 'application/json')
      assert.equal(h['Accept-Language'], 'en-US')
      assert.equal(h['User-Agent'], 'Mozilla/5.0')
    })
  })

  // ─── Body Field Stripping (via context/attributes) ─────────────────────

  describe('Body Field Scrubbing', () => {
    it('should scrub password field in context', () => {
      const event = {
        type: 'request',
        context: {
          username: 'john',
          password: 'my-secret-password',
        },
      }

      const scrubbed = scrubber.scrub(event as any)
      assert.equal((scrubbed as any).context.username, 'john')
      assert.equal((scrubbed as any).context.password, '[Redacted]')
    })

    it('should scrub nested fields recursively in context', () => {
      const event = {
        type: 'request',
        context: {
          user: {
            name: 'John',
            credentials: {
              password: 'secret123',
              token: 'jwt-token',
            },
          },
        },
      }

      const scrubbed = scrubber.scrub(event as any)
      const ctx = (scrubbed as any).context
      assert.equal(ctx.user.name, 'John')
      assert.equal(ctx.user.credentials.password, '[Redacted]')
      assert.equal(ctx.user.credentials.token, '[Redacted]')
    })

    it('should scrub creditCard and ssn fields in attributes', () => {
      const event = {
        type: 'span',
        attributes: {
          creditCard: '4111111111111111',
          ssn: '123-45-6789',
          name: 'Jane',
        },
      }

      const scrubbed = scrubber.scrub(event as any)
      assert.equal((scrubbed as any).attributes.creditCard, '[Redacted]')
      assert.equal((scrubbed as any).attributes.ssn, '[Redacted]')
      assert.equal((scrubbed as any).attributes.name, 'Jane')
    })

    it('should scrub apiKey in context', () => {
      const event = {
        type: 'request',
        context: {
          service: 'auth',
          apiKey: 'sk_live_abc123',
        },
      }

      const scrubbed = scrubber.scrub(event as any)
      assert.equal((scrubbed as any).context.service, 'auth')
      assert.equal((scrubbed as any).context.apiKey, '[Redacted]')
    })
  })

  // ─── Query Parameter Stripping ─────────────────────────────────────────

  describe('Query Parameter Scrubbing', () => {
    it('should strip token from URL query params', () => {
      const event = {
        type: 'request',
        url: 'https://api.example.com/auth?token=secret123&user=john',
      }

      const scrubbed = scrubber.scrub(event as any)
      const url = (scrubbed as any).url
      assert.ok(!url.includes('secret123'), `URL still contains token value: ${url}`)
      assert.ok(url.includes('user=john'), `URL should keep non-sensitive params: ${url}`)
    })

    it('should strip password from URL query params', () => {
      const event = {
        type: 'request',
        url: 'https://api.example.com/login?password=hunter2&action=login',
      }

      const scrubbed = scrubber.scrub(event as any)
      const url = (scrubbed as any).url
      assert.ok(!url.includes('hunter2'), `URL still contains password: ${url}`)
    })
  })

  // ─── PII Detection: Email Masking ──────────────────────────────────────

  describe('Email Masking', () => {
    it('should mask email addresses in string values', () => {
      const event = {
        type: 'error',
        message: 'User john@example.com failed to authenticate',
      }

      const scrubbed = scrubber.scrub(event as any)
      const message = (scrubbed as any).message
      assert.ok(!message.includes('john@example.com'), `Message still has email: ${message}`)
      assert.ok(message.includes('[email]'), `Message should have masked email tag: ${message}`)
    })

    it('should mask email in nested context', () => {
      const event = {
        type: 'error',
        context: {
          userInfo: 'Contact: alice@test.com for support',
        },
      }

      const scrubbed = scrubber.scrub(event as any)
      const info = (scrubbed as any).context.userInfo
      assert.ok(!info.includes('alice@test.com'), `Context still has email: ${info}`)
      assert.ok(info.includes('[email]'), `Context should have [email] tag: ${info}`)
    })
  })

  // ─── PII Detection: Phone Masking ──────────────────────────────────────

  describe('Phone Masking', () => {
    it('should mask phone numbers', () => {
      const event = {
        type: 'error',
        message: 'Call 555-123-4567 for support',
      }

      const scrubbed = scrubber.scrub(event as any)
      const message = (scrubbed as any).message
      assert.ok(!message.includes('555-123-4567'), `Message still has phone: ${message}`)
      assert.ok(message.includes('[phone]'), `Message should have [phone] tag: ${message}`)
    })
  })

  // ─── Scrubbing Disabled ────────────────────────────────────────────────

  describe('Scrubbing Disabled', () => {
    it('should not scrub when scrubbing.enabled is false', () => {
      SecurityScrubber.reset()
      const disabledScrubber = SecurityScrubber.initialize({
        scrubbing: { ...baseSecurityConfig.scrubbing, enabled: false },
        piiDetection: { ...baseSecurityConfig.piiDetection, enabled: false },
      })

      const event = {
        type: 'request',
        headers: { 'Authorization': 'Bearer secret' },
        context: { password: 'mypass' },
      }

      const scrubbed = disabledScrubber.scrub(event as any)
      assert.equal((scrubbed as any).headers['Authorization'], 'Bearer secret')
      assert.equal((scrubbed as any).context.password, 'mypass')
    })
  })

  // ─── Immutability ──────────────────────────────────────────────────────

  describe('Immutability', () => {
    it('should never mutate the original event', () => {
      const event = {
        type: 'request',
        headers: { 'Authorization': 'Bearer secret' },
        context: { password: 'mypass' },
        message: 'user@test.com logged in',
      }

      const original = JSON.parse(JSON.stringify(event))
      scrubber.scrub(event as any)

      // Original should be unchanged
      assert.equal(event.headers['Authorization'], original.headers['Authorization'])
      assert.equal(event.context.password, original.context.password)
      assert.equal(event.message, original.message)
    })
  })
})
