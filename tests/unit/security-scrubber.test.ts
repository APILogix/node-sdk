/**
 * SecurityScrubber unit tests.
 *
 * Validates:
 *   - Case-insensitive header scrubbing → `[Redacted]`.
 *   - Recursive body field stripping in `context` / `attributes` / `body`
 *     (nested objects).
 *   - Query parameter stripping from URLs.
 *   - PII masking (emails, phones).
 *   - Disabled state passes events through unchanged.
 *   - Original events are never mutated.
 *
 * v3 collapsed `scrubbing.bodyFields` and `scrubbing.queryParams` into a
 * single `scrubbing.fields` list — both bodies and query params are
 * matched against the same key set.
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fc from 'fast-check'
import { SecurityScrubber } from '../../src/processors/security-scrubber.js'
import type { PrivacyConfig } from '../../src/types/config.js'

const basePrivacyConfig: PrivacyConfig = {
  capture: { headers: true, body: true, response: false, query: true, cookies: false },
  scrubbing: {
    enabled: true,
    headers: ['authorization', 'cookie', 'x-api-key', 'x-auth-token'],
    fields: ['password', 'token', 'secret', 'creditCard', 'ssn', 'nationalId', 'apiKey', 'apikey'],
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
    scrubber = SecurityScrubber.initialize(basePrivacyConfig)
  })

  afterEach(() => {
    SecurityScrubber.reset()
  })

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
      assert.equal((scrubbed as any).headers['Authorization'], '[Redacted]')
      assert.equal((scrubbed as any).headers['Content-Type'], 'application/json')
    })

    it('should scrub cookie header', () => {
      const event = {
        type: 'request',
        headers: { 'Cookie': 'session=abc; token=secret', 'Accept': 'text/html' },
      }
      const scrubbed = scrubber.scrub(event as any)
      assert.equal((scrubbed as any).headers['Cookie'], '[Redacted]')
      assert.equal((scrubbed as any).headers['Accept'], 'text/html')
    })

    it('should scrub x-api-key header', () => {
      const event = { type: 'request', headers: { 'X-Api-Key': 'my-secret-key' } }
      assert.equal((scrubber.scrub(event as any) as any).headers['X-Api-Key'], '[Redacted]')
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
      const h = (scrubber.scrub(event as any) as any).headers
      assert.equal(h['Content-Type'], 'application/json')
      assert.equal(h['Accept-Language'], 'en-US')
      assert.equal(h['User-Agent'], 'Mozilla/5.0')
    })
  })

  describe('Body Field Scrubbing', () => {
    it('should scrub password field in context', () => {
      const event = {
        type: 'request',
        context: { username: 'john', password: 'my-secret-password' },
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
            credentials: { password: 'secret123', token: 'jwt-token' },
          },
        },
      }
      const scrubbed = scrubber.scrub(event as any)
      const ctx = (scrubbed as any).context
      assert.equal(ctx.user.name, 'John')
      assert.equal(ctx.user.credentials.password, '[Redacted]')
      assert.equal(ctx.user.credentials.token, '[Redacted]')
    })

    it('should scrub creditCard and ssn in attributes', () => {
      const event = {
        type: 'span',
        attributes: { creditCard: '4111111111111111', ssn: '123-45-6789', name: 'Jane' },
      }
      const scrubbed = scrubber.scrub(event as any)
      assert.equal((scrubbed as any).attributes.creditCard, '[Redacted]')
      assert.equal((scrubbed as any).attributes.ssn, '[Redacted]')
      assert.equal((scrubbed as any).attributes.name, 'Jane')
    })

    it('should scrub apiKey in context', () => {
      const event = { type: 'request', context: { service: 'auth', apiKey: 'sk_live_abc' } }
      const scrubbed = scrubber.scrub(event as any)
      assert.equal((scrubbed as any).context.service, 'auth')
      assert.equal((scrubbed as any).context.apiKey, '[Redacted]')
    })

    it('should scrub fields in request body objects', () => {
      const event = {
        type: 'request',
        body: { username: 'alice', password: 'top-secret', token: 'jwt' },
      }
      const scrubbed = scrubber.scrub(event as any)
      assert.equal((scrubbed as any).body.username, 'alice')
      assert.equal((scrubbed as any).body.password, '[Redacted]')
      assert.equal((scrubbed as any).body.token, '[Redacted]')
    })
  })

  describe('Query Parameter Scrubbing', () => {
    it('should strip token from URL query params', () => {
      const event = {
        type: 'request',
        url: 'https://api.example.com/auth?token=secret123&user=john',
      }
      const scrubbed = scrubber.scrub(event as any)
      const url = (scrubbed as any).url
      assert.ok(!url.includes('secret123'), `URL still contains token value: ${url}`)
      assert.ok(url.includes('user=john'))
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

  describe('PII Detection', () => {
    it('should mask email addresses in nested context strings', () => {
      const event = {
        type: 'error',
        context: { userInfo: 'Contact: alice@test.com for support' },
      }
      const scrubbed = scrubber.scrub(event as any)
      const info = (scrubbed as any).context.userInfo
      assert.ok(!info.includes('alice@test.com'), `Context still has email: ${info}`)
      assert.ok(info.includes('[email]'))
    })

    it('should mask phone numbers in nested context', () => {
      const event = {
        type: 'error',
        context: { userInfo: 'Phone: 555-123-4567' },
      }
      const scrubbed = scrubber.scrub(event as any)
      const info = (scrubbed as any).context.userInfo
      assert.ok(!info.includes('555-123-4567'))
      assert.ok(info.includes('[phone]'))
    })
  })

  describe('IPv6 PII Detection', () => {
    function ipScrubber(): SecurityScrubber {
      SecurityScrubber.reset()
      return SecurityScrubber.initialize({
        ...basePrivacyConfig,
        piiDetection: { ...basePrivacyConfig.piiDetection, maskIPs: true },
      })
    }

    it('masks full, compressed, bracketed, link-local, loopback, and IPv4-mapped IPv6', () => {
      const enabled = ipScrubber()
      const addresses = [
        '2001:0db8:0000:0000:0000:ff00:0042:8329',
        '2001:db8::1',
        '[2001:db8::1]:443',
        'fe80::1%eth0',
        '::1',
        '::ffff:192.0.2.1',
      ]
      const scrubbed = enabled.scrub({ type: 'message', message: addresses.join(' | '), severity: 'info', timestamp: 1 } as any) as any
      for (const address of addresses) assert.ok(!scrubbed.message.includes(address), `IPv6 leaked: ${address}`)
      assert.ok(scrubbed.message.includes('[ip]'))
    })

    it('does not corrupt timestamps, MAC addresses, or ordinary colon text', () => {
      const enabled = ipScrubber()
      const message = 'at 12:34:56 adapter aa:bb:cc:dd:ee:ff key:value'
      const scrubbed = enabled.scrub({ type: 'message', message, severity: 'info', timestamp: 1 } as any) as any
      assert.equal(scrubbed.message, message)
    })

    it('masks arbitrary valid IPv6 strings', () => {
      const enabled = ipScrubber()
      fc.assert(fc.property(fc.ipV6(), address => {
        const result = enabled.scrubValue(`remote=${address}`) as string
        assert.ok(!result.includes(address), `generated IPv6 leaked: ${address}`)
      }), { numRuns: 100 })
    })
  })

  describe('Scrubbing Disabled', () => {
    it('should pass events through unchanged when scrubbing.enabled is false', () => {
      SecurityScrubber.reset()
      const disabled = SecurityScrubber.initialize({
        ...basePrivacyConfig,
        scrubbing: { ...basePrivacyConfig.scrubbing, enabled: false },
        piiDetection: { ...basePrivacyConfig.piiDetection, enabled: false },
      })

      const event = {
        type: 'request',
        headers: { 'Authorization': 'Bearer secret' },
        context: { password: 'mypass' },
      }
      const scrubbed = disabled.scrub(event as any)
      assert.equal((scrubbed as any).headers['Authorization'], 'Bearer secret')
      assert.equal((scrubbed as any).context.password, 'mypass')
    })
  })

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

      assert.equal(event.headers['Authorization'], original.headers['Authorization'])
      assert.equal(event.context.password, original.context.password)
      assert.equal(event.message, original.message)
    })
  })
})
