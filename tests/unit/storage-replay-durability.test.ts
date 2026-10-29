import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PersistentStorage } from '../../src/storage/persistent-storage.js'
import type { Event } from '../../src/types/event.js'

const storages: PersistentStorage[] = []

function makeStorage(directory: string): PersistentStorage {
  const storage = new PersistentStorage()
  storage.configure({
    directory,
    apiKeyHash: 'replay-test',
    maxEvents: 30_000,
    maxFileSizeBytes: 100 * 1024 * 1024,
    ioTimeoutMs: 5_000,
  })
  storages.push(storage)
  return storage
}

function makeEvent(index: number): Event {
  return {
    type: 'log',
    eventId: `replay-${index}`,
    timestamp: Date.now(),
    message: `offline event ${index}`,
  } as unknown as Event
}

afterEach(async () => {
  await Promise.all(storages.splice(0).map(storage => storage.shutdown()))
})

describe('Persistent replay durability', () => {
  it('retains a 20,000 event queue until backend acknowledgements remove its IDs', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lynktrace-replay-durable-'))
    try {
      const writer = makeStorage(directory)
      await writer.init()
      writer.persistBatch(Array.from({ length: 20_000 }, (_, index) => makeEvent(index)))
      await writer.flush()
      await writer.shutdown()

      const replayStorage = makeStorage(directory)
      const replayed = await replayStorage.init()
      assert.equal(replayed.length, 20_000)
      assert.ok((await readdir(directory)).some(name => name.endsWith('.ndjson')))

      const acknowledged = replayed.slice(0, 7_900)
      await replayStorage.discard(acknowledged)
      assert.ok((await readdir(directory)).some(name => name.endsWith('.ndjson')), 'partial ACKs must retain the unacknowledged queue')

      const remaining = await replayStorage.replay()
      assert.equal(remaining.length, 12_100)
      const acknowledgedIds = new Set(acknowledged.map(event => event.eventId))
      assert.equal(remaining.some(event => acknowledgedIds.has(event.eventId)), false, 'ACKed events must not replay')
      await replayStorage.discard(remaining)
      assert.equal((await readdir(directory)).some(name => name.endsWith('.ndjson')), false)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('restores a queue file when replay is aborted during its read', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lynktrace-replay-abort-'))
    try {
      const writer = makeStorage(directory)
      await writer.init()
      writer.persistBatch(Array.from({ length: 20_000 }, (_, index) => makeEvent(index)))
      await writer.flush()
      await writer.shutdown()

      const replayStorage = makeStorage(directory)
      await replayStorage.init()
      await replayStorage.shutdown()

      const source = await readdir(directory)
      const replayFile = source.find(name => name.endsWith('.ndjson'))
      assert.ok(replayFile, 'replay source must exist before claiming')
      const controller = new AbortController()
      const replay = replayStorage.replay(undefined, controller.signal)
      const poll = setInterval(async () => {
        try {
          const names = await readdir(directory)
          if (names.some(name => name.includes('.claim-'))) controller.abort()
        } catch {
          controller.abort()
        }
      }, 1)
      let result: Event[]
      try {
        result = await replay
      } finally {
        clearInterval(poll)
      }
      assert.deepEqual(result, [])
      const namesAfter = await readdir(directory)
      assert.ok(namesAfter.includes(replayFile), 'aborted claim must return to its original durable name')
      assert.equal(namesAfter.some(name => name.includes('.claim-')), false)

      const recovered = await replayStorage.replay()
      assert.equal(recovered.length, 20_000, 'a later startup must be able to replay every event')
      await replayStorage.discard(recovered)
      assert.equal((await readdir(directory)).some(name => name.endsWith('.ndjson')), false)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('removes a synchronously persisted retry after its successful acknowledgement', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lynktrace-retry-ack-'))
    try {
      const storage = makeStorage(directory)
      await storage.init()
      const event = makeEvent(1)
      storage.flushSync([event])
      assert.ok((await readdir(directory)).some(name => name.endsWith('.ndjson')))

      await storage.discard([event])
      assert.equal((await readdir(directory)).some(name => name.endsWith('.ndjson')), false)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
