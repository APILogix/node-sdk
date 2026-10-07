import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { safeJsonStringify } from '../../src/utils/safe-json.js'
import { sanitizeEvent } from '../../src/processors/sanitizer.js'
import { SecurityScrubber } from '../../src/processors/security-scrubber.js'
import type { SDKEvent } from '../../src/types/event.js'

describe('SEC-04: BigInt & Serialization Safety', () => {
  it('safeJsonStringify handles BigInt primitives in shallow and deep structures', () => {
    const data = {
      id: 9007199254740993n,
      nested: {
        count: 1234567890123456789n,
        list: [1n, 2n, 3n],
      },
      regular: 'hello',
    }

    const json = safeJsonStringify(data)
    assert.doesNotThrow(() => JSON.parse(json))
    const parsed = JSON.parse(json)
    assert.strictEqual(parsed.id, '9007199254740993')
    assert.strictEqual(parsed.nested.count, '1234567890123456789')
    assert.deepStrictEqual(parsed.nested.list, ['1', '2', '3'])
    assert.strictEqual(parsed.regular, 'hello')
  })

  it('safeJsonStringify handles circular references without throwing', () => {
    const circularObj: Record<string, unknown> = { name: 'test' }
    circularObj.self = circularObj

    const json = safeJsonStringify(circularObj)
    assert.doesNotThrow(() => JSON.parse(json))
    const parsed = JSON.parse(json)
    assert.strictEqual(parsed.name, 'test')
    assert.strictEqual(parsed.self, '[Circular]')
  })

  it('sanitizeEvent converts BigInt to string in event attributes and extra', () => {
    const event: any = {
      type: 'span',
      eventId: 'evt-1',
      timestamp: Date.now(),
      name: 'test-span',
      attributes: {
        'db.row_count': 5000000000n,
      },
      extra: {
        orderId: 9876543210987654321n,
      },
    }

    const sanitized = sanitizeEvent(event) as any
    assert.strictEqual(sanitized.attributes['db.row_count'], '5000000000')
    assert.strictEqual(sanitized.extra.orderId, '9876543210987654321')

    // Standard JSON.stringify should succeed without custom replacer
    assert.doesNotThrow(() => JSON.stringify(sanitized))
  })

  it('SecurityScrubber.scrubValue handles BigInt without throwing', () => {
    const scrubber = SecurityScrubber.initialize({
      scrubbing: {
        enabled: true,
        headers: ['authorization'],
        fields: ['password'],
      },
      capture: {
        body: false,
        headers: true,
        query: true,
        cookies: false,
        response: false,
      },
      piiDetection: {
        enabled: true,
        maskEmails: true,
        maskPhones: true,
        maskIPs: true,
      },
    })

    const payload = {
      userId: 1234567890123456789n,
      safeVal: 'ok',
    }

    const scrubbed = scrubber.scrubValue(payload) as any
    assert.strictEqual(scrubbed.userId, '1234567890123456789')
    assert.strictEqual(scrubbed.safeVal, 'ok')
    assert.doesNotThrow(() => JSON.stringify(scrubbed))
  })
})
