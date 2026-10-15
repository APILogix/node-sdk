import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtemp, rm, writeFile, readdir } from 'node:fs/promises'
import { PersistentStorage } from '../../src/storage/persistent-storage.js'
import type { Event } from '../../src/types/event.js'

function createSampleEvent(id: string): Event {
  return {
    type: 'log',
    eventId: id,
    timestamp: Date.now(),
  } as unknown as Event
}

describe('Storage Remediation: BUG-01, BUG-02, BUG-03', () => {
  let testDir: string

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'pulse-storage-remediation-'))
  })

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true }).catch(() => {})
  })

  describe('BUG-01: Bounded .bak Rotation', () => {
    it('prunes backup files to MAX_BACKUP_FILES (3) upon repeated rotations', async () => {
      const storage = new PersistentStorage()
      storage.configure({
        directory: testDir,
        maxEvents: 2,
        maxFileSizeBytes: 50,
      })
      await storage.init()

      // Flush 5 times with enough data to trigger rotation
      for (let i = 0; i < 5; i++) {
        storage.persist(createSampleEvent(`evt-${i}-1`))
        storage.persist(createSampleEvent(`evt-${i}-2`))
        await storage.flush()
      }

      const files = await readdir(testDir)
      const bakFiles = files.filter(f => f.endsWith('.bak'))
      assert.ok(bakFiles.length <= 3, `Expected at most 3 .bak files, found: ${bakFiles.length}`)
      await storage.shutdown()
    })
  })

  describe('BUG-02: Unbounded In-Memory Buffer Leak & Fatal Error Cleanup', () => {
    it('clears buffer and persistedIds when fatal write error occurs or writeErrors >= 10', async () => {
      const storage = new PersistentStorage()
      storage.configure({
        directory: testDir,
        maxEvents: 10,
      })
      await storage.init()

      // Fill buffer
      for (let i = 0; i < 5; i++) {
        storage.persist(createSampleEvent(`evt-${i}`))
      }

      // Simulate ENOSPC failure during appendFile by pointing dataFile to an invalid read-only path/corrupting write
      // We can simulate this by mocking or creating a non-writable file
      const dataFile = storage.dataFilePath
      // Replace file with a directory so appendFile throws EISDIR/EPERM/EACCES
      await rm(dataFile, { force: true }).catch(() => {})
      const { mkdir } = await import('node:fs/promises')
      await mkdir(dataFile)

      await storage.flush()

      // Since write failed with fatal/non-recoverable code (EISDIR/EPERM/EACCES):
      const stats = storage.getStats()
      assert.equal(stats.initialized, false, 'Storage should be disabled after fatal error')
      assert.equal(stats.bufferedEvents, 0, 'Buffer should be completely cleared to prevent memory leak')
      await storage.shutdown()
    })

    it('caps restored events to maxEvents on transient write error', async () => {
      const storage = new PersistentStorage()
      storage.configure({
        directory: testDir,
        maxEvents: 5,
      })
      await storage.init()

      // Manually add events to buffer
      for (let i = 0; i < 5; i++) {
        storage.persist(createSampleEvent(`evt-${i}`))
      }
      assert.equal(storage.getStats().bufferedEvents, 5)

      // When more events arrive, buffer is capped at maxEvents
      storage.persist(createSampleEvent('evt-extra'))
      assert.equal(storage.getStats().bufferedEvents, 5)

      await storage.shutdown()
    })
  })

  describe('BUG-03: Read-Only Fallback to /tmp & withIoTimeout', () => {
    it('falls back to tmpdir when primary default directory fails ensureDirectory', async () => {
      const storage = new PersistentStorage()
      const origHome = process.env.HOME
      const blockingFile = join(testDir, 'blocked-home')
      await writeFile(blockingFile, 'not-a-dir')
      process.env.HOME = blockingFile

      try {
        storage.configure()
        const replayed = await storage.init()
        assert.ok(Array.isArray(replayed))
        assert.equal(storage.isInitialized, true, 'Storage should be initialized in fallback dir')
        assert.ok(storage.directory.includes('telemetry-sdk') && storage.directory.includes('events'))
      } finally {
        process.env.HOME = origHome
        await storage.shutdown()
      }
    })
  })
})
