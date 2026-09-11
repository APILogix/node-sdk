import { it } from 'node:test'
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { sanitizeEvent } from '../../src/processors/sanitizer.js'
import { SecurityScrubber } from '../../src/processors/security-scrubber.js'
import { TEST_REMOTE_CONFIG } from '../fixtures/remote-config.js'
import type { SDKEvent } from '../../src/types/event.js'

it('scrubs long non-email messages without quadratic scanning and still redacts email', () => {
  const scrubber = SecurityScrubber.initialize({
    ...TEST_REMOTE_CONFIG.privacy,
    piiDetection: { enabled: true, maskEmails: true, maskPhones: false, maskIPs: false },
  })
  try {
    for (const message of ['A'.repeat(60 * 1024), 'a.b-_%+'.repeat(10_000)]) {
      const event = { type: 'error', message: `${message} contact user.name+tag@example.com` } as SDKEvent
      const started = performance.now()
      const sanitized = sanitizeEvent(event) as { message: string }
      const secured = scrubber.scrub(event) as { message: string }
      const elapsed = performance.now() - started
      assert.ok(elapsed < 1000, `scrubbing blocked for ${elapsed.toFixed(1)}ms`)
      assert.equal(sanitized.message, `${message} contact [email]`)
      assert.equal(secured.message, `${message} contact [email]`)
    }
  } finally {
    SecurityScrubber.reset()
  }
})
