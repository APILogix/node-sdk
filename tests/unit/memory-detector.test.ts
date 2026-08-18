import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import {
  detectMemoryLimit,
  resolveMaxMemoryMb,
  clearMemoryDetectionCache,
} from '../../src/utils/memory-detector.js'

const VALID_SOURCES = ['cgroup-v2', 'cgroup-v1', 'v8-heap', 'windows-os', 'fallback'] as const
const VALID_CONFIDENCES = ['high', 'medium', 'low'] as const

describe('memory-detector', () => {
  beforeEach(() => {
    clearMemoryDetectionCache()
  })

  describe('resolveMaxMemoryMb with explicit numbers', () => {
    it('returns 256 for input 256', () => {
      assert.equal(resolveMaxMemoryMb(256), 256)
    })

    it('returns 64 for input 64 (min boundary)', () => {
      assert.equal(resolveMaxMemoryMb(64), 64)
    })

    it('returns 1024 for input 1024 (max boundary)', () => {
      assert.equal(resolveMaxMemoryMb(1024), 1024)
    })

    it('clamps values below 64 to 64', () => {
      assert.equal(resolveMaxMemoryMb(10), 64)
      assert.equal(resolveMaxMemoryMb(0), 64)
      assert.equal(resolveMaxMemoryMb(1), 64)
      assert.equal(resolveMaxMemoryMb(63), 64)
    })

    it('clamps values above 1024 to 1024', () => {
      assert.equal(resolveMaxMemoryMb(1025), 1024)
      assert.equal(resolveMaxMemoryMb(2048), 1024)
      assert.equal(resolveMaxMemoryMb(99999), 1024)
    })
  })

  describe('resolveMaxMemoryMb with auto', () => {
    it('returns a number between 64 and 1024', () => {
      const result = resolveMaxMemoryMb('auto')
      assert.equal(typeof result, 'number')
      assert.ok(result >= 64, `expected >= 64, got ${result}`)
      assert.ok(result <= 1024, `expected <= 1024, got ${result}`)
    })
  })

  describe('detectMemoryLimit', () => {
    it('returns a valid MemoryDetectionResult', () => {
      const result = detectMemoryLimit()

      assert.ok(result.detectedLimitMb > 0, `detectedLimitMb should be > 0, got ${result.detectedLimitMb}`)

      assert.ok(
        result.effectiveLimitMb >= 64,
        `effectiveLimitMb should be >= 64, got ${result.effectiveLimitMb}`,
      )
      assert.ok(
        result.effectiveLimitMb <= 1024,
        `effectiveLimitMb should be <= 1024, got ${result.effectiveLimitMb}`,
      )

      assert.ok(
        (VALID_SOURCES as readonly string[]).includes(result.source),
        `source should be one of ${VALID_SOURCES.join(', ')}, got ${result.source}`,
      )

      assert.ok(
        (VALID_CONFIDENCES as readonly string[]).includes(result.confidence),
        `confidence should be one of ${VALID_CONFIDENCES.join(', ')}, got ${result.confidence}`,
      )
    })

    it('has detectedLimitMb > 0', () => {
      const result = detectMemoryLimit()
      assert.ok(result.detectedLimitMb > 0)
    })

    it('has effectiveLimitMb between 64 and 1024', () => {
      const result = detectMemoryLimit()
      assert.ok(result.effectiveLimitMb >= 64)
      assert.ok(result.effectiveLimitMb <= 1024)
    })

    it('has a valid source', () => {
      const result = detectMemoryLimit()
      assert.ok((VALID_SOURCES as readonly string[]).includes(result.source))
    })

    it('has a valid confidence', () => {
      const result = detectMemoryLimit()
      assert.ok((VALID_CONFIDENCES as readonly string[]).includes(result.confidence))
    })
  })

  describe('cache behavior', () => {
    it('two consecutive calls return the same object reference', () => {
      const first = detectMemoryLimit()
      const second = detectMemoryLimit()
      assert.strictEqual(first, second)
    })

    it('after clearMemoryDetectionCache(), next call returns a fresh result', () => {
      const first = detectMemoryLimit()
      clearMemoryDetectionCache()
      const second = detectMemoryLimit()
      // Should be a new object (not the same reference)
      // Note: values may be identical but reference should differ
      assert.notStrictEqual(first, second)
    })
  })

  describe('platform-specific source', () => {
    it('returns expected source for current platform', () => {
      const result = detectMemoryLimit()

      if (process.platform === 'win32') {
        assert.ok(
          result.source === 'windows-os' || result.source === 'v8-heap',
          `on Windows, source should be 'windows-os' or 'v8-heap', got '${result.source}'`,
        )
      } else if (process.platform === 'linux') {
        assert.ok(
          result.source === 'cgroup-v2' ||
            result.source === 'cgroup-v1' ||
            result.source === 'v8-heap',
          `on Linux, source should be 'cgroup-v2', 'cgroup-v1', or 'v8-heap', got '${result.source}'`,
        )
      }
      // On other platforms (darwin, etc.), any valid source is acceptable
    })
  })
})
