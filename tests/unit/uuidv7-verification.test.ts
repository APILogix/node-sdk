import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  generateId,
  generateShortId,
  isValidUUID,
  isValidUUIDv7,
  extractTimestampFromUUIDv7,
} from '../../src/utils/uuid.js'

describe('UUIDv7 RFC 9562 Generator & Validator', () => {
  it('generates valid UUIDv7 strings conforming to RFC 9562', () => {
    const id = generateId()
    assert.equal(typeof id, 'string')
    assert.equal(id.length, 36)
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
    assert.ok(isValidUUIDv7(id), 'isValidUUIDv7 should return true for generated id')
    assert.ok(isValidUUID(id), 'isValidUUID should return true for generated id')
  })

  it('generates valid short IDs', () => {
    const shortId = generateShortId()
    assert.equal(typeof shortId, 'string')
    assert.equal(shortId.length, 16)
  })

  it('accurately encodes current timestamp into UUIDv7', () => {
    const before = Date.now()
    const id = generateId()
    const after = Date.now()

    const extracted = extractTimestampFromUUIDv7(id)
    assert.ok(extracted !== null, 'timestamp must be extractable from UUIDv7')
    assert.ok(extracted >= before - 10, 'extracted timestamp should be >= before')
    assert.ok(extracted <= after + 10, 'extracted timestamp should be <= after')
  })

  it('guarantees monotonic ordering in high-frequency generation', () => {
    const count = 1000
    const ids: string[] = []
    for (let i = 0; i < count; i++) {
      ids.push(generateId())
    }

    for (let i = 1; i < count; i++) {
      const prev = ids[i - 1]
      const curr = ids[i]
      assert.ok(prev !== undefined && curr !== undefined)
      // Monotonic strictly increasing in lexicographical order
      assert.ok(prev < curr, `ID at index ${i - 1} (${prev}) should be < ID at index ${i} (${curr})`)
    }
  })

  it('maintains backward compatibility with UUIDv4', () => {
    const legacyV4 = 'f47ac10b-58cc-4372-a567-0e02b2c3d479'
    assert.ok(isValidUUID(legacyV4), 'isValidUUID must accept valid UUIDv4')
    assert.strictEqual(isValidUUIDv7(legacyV4), false, 'isValidUUIDv7 must reject UUIDv4')
    assert.strictEqual(extractTimestampFromUUIDv7(legacyV4), null, 'extractTimestampFromUUIDv7 must return null for v4')
  })
})

