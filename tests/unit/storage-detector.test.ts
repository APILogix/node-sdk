import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { StorageDetector } from '../../src/utils/storage-detector.js'

describe('Storage Detector', () => {
  it('samples storage volume safely using statfs', () => {
    const snapshot = StorageDetector.sample()

    if (snapshot !== null) {
      assert.ok(typeof snapshot.totalBytes === 'number', 'totalBytes should be a number')
      assert.ok(typeof snapshot.freeBytes === 'number', 'freeBytes should be a number')
      assert.ok(typeof snapshot.usedBytes === 'number', 'usedBytes should be a number')
      assert.ok(typeof snapshot.usedPercent === 'number', 'usedPercent should be a number')

      assert.ok(snapshot.totalBytes >= 0, 'totalBytes should be non-negative')
      assert.ok(snapshot.freeBytes >= 0, 'freeBytes should be non-negative')
      assert.ok(snapshot.usedBytes >= 0, 'usedBytes should be non-negative')
      assert.ok(snapshot.usedPercent >= 0 && snapshot.usedPercent <= 100, 'usedPercent should be between 0 and 100')
    }
  })

  it('safely handles non-existent or inaccessible paths by returning null', () => {
    const nonExistentPath = '/non/existent/volume/path/lynktrace-test-xyz-999'
    const result = StorageDetector.sample(nonExistentPath)
    assert.strictEqual(result, null, 'Should return null for non-existent path without throwing')
  })
})

