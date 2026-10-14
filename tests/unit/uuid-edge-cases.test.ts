import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Worker } from 'node:worker_threads'
import { generateId, generateShortId, isValidUUID } from '../../src/utils/uuid.js'

describe('RFC 9562 UUIDv7 Invariant & Edge Case Collision Resistance', () => {
  it('generates 500,000 sequential UUIDs with 0 duplicates and strict monotonicity', () => {
    const total = 500_000
    const set = new Set<string>()
    let prev = ''
    let isMonotonic = true

    for (let i = 0; i < total; i++) {
      const id = generateId()
      assert.equal(set.has(id), false, `Duplicate UUID generated at index ${i}: ${id}`)
      set.add(id)
      if (prev && id <= prev) {
        isMonotonic = false
      }
      prev = id
    }

    assert.equal(set.size, total)
    assert.equal(isMonotonic, true)
  })

  it('guarantees zero collisions and monotonicity during clock freeze (same millisecond)', () => {
    const originalNow = Date.now
    const FROZEN_MS = 1_718_000_000_000
    Date.now = () => FROZEN_MS

    try {
      const count = 50_000
      const set = new Set<string>()
      let prev = ''
      let isMonotonic = true

      for (let i = 0; i < count; i++) {
        const id = generateId()
        assert.equal(set.has(id), false, `Duplicate during clock freeze at index ${i}: ${id}`)
        set.add(id)
        if (prev && id <= prev) {
          isMonotonic = false
        }
        prev = id
      }

      assert.equal(set.size, count)
      assert.equal(isMonotonic, true)
    } finally {
      Date.now = originalNow
    }
  })

  it('guarantees zero collisions when system clock rewinds (NTP backwards drift)', () => {
    const originalNow = Date.now
    let mockTime = 1_718_000_500_000
    Date.now = () => mockTime
    generateId() // Prime timestamp

    try {
      const count = 50_000
      const set = new Set<string>()
      let prev = ''
      let isMonotonic = true

      for (let i = 0; i < count; i++) {
        // Rewind clock backwards every 250 calls
        if (i % 250 === 0) {
          mockTime -= 100 // 100ms backwards jump
        }
        const id = generateId()
        assert.equal(set.has(id), false, `Duplicate during backward clock skew at index ${i}: ${id}`)
        set.add(id)
        if (prev && id <= prev) {
          isMonotonic = false
        }
        prev = id
      }

      assert.equal(set.size, count)
      assert.equal(isMonotonic, true)
    } finally {
      Date.now = originalNow
    }
  })

  it('guarantees zero cross-thread collisions across concurrent workers', async () => {
    const NUM_WORKERS = 4
    const PER_WORKER = 50_000
    const workerScript = `
      const { parentPort, workerData } = require('node:worker_threads');
      const { generateId } = require('./dist/utils/uuid.js');
      const ids = [];
      for (let i = 0; i < workerData.count; i++) {
        ids.push(generateId());
      }
      parentPort.postMessage(ids);
    `

    const workerPromises = Array.from({ length: NUM_WORKERS }, () => {
      return new Promise<string[]>((resolve, reject) => {
        const worker = new Worker(workerScript, {
          eval: true,
          workerData: { count: PER_WORKER },
        })
        worker.on('message', resolve)
        worker.on('error', reject)
      })
    })

    const results = await Promise.all(workerPromises)
    const globalSet = new Set<string>()
    let duplicates = 0

    for (const ids of results) {
      for (const id of ids) {
        if (globalSet.has(id)) {
          duplicates++
        }
        globalSet.add(id)
      }
    }

    assert.equal(duplicates, 0, `Detected ${duplicates} cross-worker UUID collisions`)
    assert.equal(globalSet.size, NUM_WORKERS * PER_WORKER)
  })

  it('strictly validates RFC 9562 format and bit constraints', () => {
    for (let i = 0; i < 5_000; i++) {
      const id = generateId()
      assert.equal(id.length, 36)
      assert.equal(isValidUUID(id), true)
      assert.equal(id[14], '7', `UUIDv7 version bit must be 7: ${id}`)
      assert.equal(['8', '9', 'a', 'b'].includes(id[19]!.toLowerCase()), true, `UUIDv7 variant bit must be 8/9/a/b: ${id}`)
      assert.equal(id[8], '-')
      assert.equal(id[13], '-')
      assert.equal(id[18], '-')
      assert.equal(id[23], '-')
    }
  })

  it('generates unique 16-hex short IDs from entropy pool without collisions', () => {
    const total = 50_000
    const set = new Set<string>()
    for (let i = 0; i < total; i++) {
      const sid = generateShortId()
      assert.equal(sid.length, 16)
      assert.equal(/^[0-9a-f]{16}$/.test(sid), true)
      assert.equal(set.has(sid), false, `Short ID duplicate: ${sid}`)
      set.add(sid)
    }
    assert.equal(set.size, total)
  })
})
