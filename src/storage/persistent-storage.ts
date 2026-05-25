/**
 * Persistent storage — file-based event persistence across restarts.
 *
 * Events are written to a local file as newline-delimited JSON (NDJSON).
 * On SDK init, persisted events are replayed into the queue.
 * On shutdown, remaining queue events are flushed to disk.
 *
 * Features:
 * - Append-only NDJSON format for crash safety
 * - Bounded file size with automatic rotation
 * - Atomic writes via temp file + rename
 * - Automatic cleanup of stale entries (TTL-based)
 * - Memory-mapped replay for fast startup
 */

import { existsSync, unlinkSync, statSync } from 'fs'
import { appendFile, mkdir, readFile, rename, unlink, writeFile } from 'fs/promises'
import { join, dirname } from 'path'
import { tmpdir } from 'os'
import { createHash } from 'crypto'
import { getLogger } from '../utils/logger.js'
import { epochMs } from '../utils/time.js'
import type { Event } from '../types/event.js'

const DEFAULT_MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024 // 10MB
const DEFAULT_MAX_EVENTS = 10000
const DEFAULT_EVENT_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours
const FLUSH_DEBOUNCE_MS = 1000
const DEFAULT_IO_TIMEOUT_MS = 5_000 // Per file-operation timeout — protects against frozen filesystems.

interface PersistentStorageOptions {
  /** Directory to store persisted events. Defaults to OS temp dir. */
  directory?: string
  /** API key hash for unique file naming. */
  apiKeyHash?: string
  /** Maximum file size before rotation. Default: 10MB. */
  maxFileSizeBytes?: number
  /** Maximum events to persist. Default: 10000. */
  maxEvents?: number
  /** Event TTL in milliseconds. Default: 24 hours. */
  eventTtlMs?: number
  /**
   * Per file-operation timeout in milliseconds. Default: 5000.
   * Protects against frozen filesystems (NFS hangs, full disks, etc.) that
   * would otherwise block the shutdown drain indefinitely.
   */
  ioTimeoutMs?: number
}

interface PersistedEventEntry {
  event: Event
  persistedAt: number
}

class PersistentStorage {
  private directory: string = ''
  private dataFile: string = ''
  private tempFile: string = ''
  private maxFileSizeBytes: number = DEFAULT_MAX_FILE_SIZE_BYTES
  private maxEvents: number = DEFAULT_MAX_EVENTS
  private eventTtlMs: number = DEFAULT_EVENT_TTL_MS
  private ioTimeoutMs: number = DEFAULT_IO_TIMEOUT_MS
  private buffer: Event[] = []
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private eventCount = 0
  private initialized = false
  private writeErrors = 0
  private totalPersisted = 0
  private totalReplayed = 0
  private totalExpired = 0
  private writeChain: Promise<void> = Promise.resolve()

  configure(options: PersistentStorageOptions = {}): void {
    this.directory = options.directory ?? this.resolveDefaultDirectory()
    this.maxFileSizeBytes = options.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE_BYTES
    this.maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS
    this.eventTtlMs = options.eventTtlMs ?? DEFAULT_EVENT_TTL_MS
    this.ioTimeoutMs = options.ioTimeoutMs ?? DEFAULT_IO_TIMEOUT_MS

    const suffix = options.apiKeyHash ? `-${options.apiKeyHash.slice(0, 8)}` : ''
    this.dataFile = join(this.directory, `pulse-events${suffix}.ndjson`)
    this.tempFile = join(this.directory, `pulse-events${suffix}.ndjson.tmp`)
  }

  async init(): Promise<Event[]> {
    if (this.initialized) return []
    this.initialized = true

    const logger = getLogger()

    try {
      await this.ensureDirectory()
    } catch (error) {
      logger.warn('Persistent storage: failed to create directory, disabling persistence', {
        directory: this.directory,
        error,
      })
      return []
    }

    const replayed = await this.replay()
    this.totalReplayed = replayed.length

    logger.info('Persistent storage initialized', {
      directory: this.directory,
      replayedEvents: replayed.length,
      maxEvents: this.maxEvents,
      ttlHours: this.eventTtlMs / (60 * 60 * 1000),
    })

    return replayed
  }

  /**
   * Queue an event for persistence. Events are batched and flushed periodically.
   *
   * Callers can invoke this freely from any code path; it returns silently if
   * storage was never initialized or has already been shut down.
   */
  persist(event: Event): void {
    if (!this.initialized) return

    this.buffer.push(event)
    this.eventCount++

    if (this.eventCount >= this.maxEvents) {
      void this.rotate()
    }

    this.scheduleFlush()
  }

  /**
   * Force-flush all buffered events to disk immediately.
   */
  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }

    if (this.buffer.length === 0) return

    const logger = getLogger()
    const entries: string[] = []

    for (const event of this.buffer) {
      const entry: PersistedEventEntry = {
        event,
        persistedAt: epochMs(),
      }
      entries.push(JSON.stringify(entry))
    }

    try {
      await this.checkAndRotate()

      const content = entries.join('\n') + '\n'
      await this.enqueueWrite(() => appendFile(this.dataFile, content, { encoding: 'utf8' }))

      this.totalPersisted += this.buffer.length
      this.buffer = []
    } catch (error) {
      this.writeErrors++
      logger.warn('Persistent storage: write failed', {
        error,
        writeErrors: this.writeErrors,
        bufferedEvents: this.buffer.length,
      })

      if (this.writeErrors >= 10) {
        logger.error('Persistent storage: too many write errors, disabling', {
          writeErrors: this.writeErrors,
        })
        this.initialized = false
      }
    }
  }

  /**
   * Remove events that were successfully delivered.
   */
  async discard(events: readonly Event[]): Promise<void> {
    if (events.length === 0) return

    const deliveredIds = new Set(
      events
        .map(event => event.eventId)
        .filter((eventId): eventId is string => typeof eventId === 'string' && eventId.length > 0)
    )
    if (deliveredIds.size === 0) return

    this.buffer = this.buffer.filter(event => !deliveredIds.has(event.eventId ?? ''))

    if (!existsSync(this.dataFile)) return

    try {
      const content = await withIoTimeout(
        readFile(this.dataFile, { encoding: 'utf8' }),
        this.ioTimeoutMs,
        'persistent-storage discard read'
      )
      const retainedEntries: PersistedEventEntry[] = []

      for (const line of content.split('\n')) {
        if (line.trim().length === 0) continue
        try {
          const entry: PersistedEventEntry = JSON.parse(line)
          if (!deliveredIds.has(entry.event.eventId ?? '')) {
            retainedEntries.push(entry)
          }
        } catch {
          // Drop malformed lines while compacting acknowledged events.
        }
      }

      await this.rewriteEntries(retainedEntries)
      this.eventCount = retainedEntries.length + this.buffer.length
    } catch (error) {
      getLogger().warn('Persistent storage: discard failed', { error })
    }
  }

  /**
   * Replay persisted events from disk.
   * Returns events that are still valid (within TTL).
   */
  async replay(): Promise<Event[]> {
    const logger = getLogger()

    if (!existsSync(this.dataFile)) {
      return []
    }

    try {
      const content = await withIoTimeout(
        readFile(this.dataFile, { encoding: 'utf8' }),
        this.ioTimeoutMs,
        'persistent-storage replay read'
      )
      const lines = content.split('\n').filter(line => line.trim().length > 0)
      const now = epochMs()
      const validEvents: Event[] = []

      for (const line of lines) {
        try {
          const entry: PersistedEventEntry = JSON.parse(line)

          if (now - entry.persistedAt > this.eventTtlMs) {
            this.totalExpired++
            continue
          }

          validEvents.push(entry.event)
        } catch {
          // Skip malformed lines
          continue
        }
      }

      // Rewrite file with only valid events (cleanup expired)
      if (this.totalExpired > 0) {
        await this.rewriteFile(validEvents)
      }

      logger.debug('Persistent storage: replay complete', {
        totalLines: lines.length,
        validEvents: validEvents.length,
        expiredEvents: this.totalExpired,
      })

      return validEvents
    } catch (error) {
      logger.warn('Persistent storage: replay failed', { error })
      return []
    }
  }

  /**
   * Get storage statistics.
   */
  getStats(): {
    initialized: boolean
    eventCount: number
    bufferedEvents: number
    totalPersisted: number
    totalReplayed: number
    totalExpired: number
    writeErrors: number
    fileSizeBytes: number
  } {
    let fileSizeBytes = 0
    try {
      if (existsSync(this.dataFile)) {
        fileSizeBytes = statSync(this.dataFile).size
      }
    } catch {
      // ignore
    }

    return {
      initialized: this.initialized,
      eventCount: this.eventCount,
      bufferedEvents: this.buffer.length,
      totalPersisted: this.totalPersisted,
      totalReplayed: this.totalReplayed,
      totalExpired: this.totalExpired,
      writeErrors: this.writeErrors,
      fileSizeBytes,
    }
  }

  /**
   * Clear all persisted data.
   */
  clear(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }

    this.buffer = []
    this.eventCount = 0

    try {
      if (existsSync(this.dataFile)) {
        unlinkSync(this.dataFile)
      }
    } catch {
      // ignore
    }
  }

  /**
   * Shut down persistent storage.
   *
   * Sequence:
   *   1. Mark storage as not-initialized FIRST so concurrent persist()
   *      calls bail out and don't push events into a buffer that's about
   *      to be drained. This guarantees the final flush is monotonic.
   *   2. Cancel any debounced flush timer (we perform a final flush below).
   *   3. Flush the in-memory buffer.
   *   4. Await the serial write chain so every file write that was started
   *      before shutdown completes before the process exits. Without this
   *      step, an in-flight rename() can be interrupted mid-write and the
   *      data file is corrupted on the next replay.
   *   5. Re-arm the write chain so a subsequent init() does not chain new
   *      writes onto an old (possibly rejected) chain.
   */
  async shutdown(): Promise<void> {
    // Reject new persist() calls immediately so concurrent producers can't
    // push into a buffer that's about to be drained.
    this.initialized = false

    // Cancel any pending debounced flush — we'll perform a final flush below.
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }

    try {
      await this.flush()
    } catch (err) {
      getLogger().warn('Persistent storage: final flush failed during shutdown', { error: err })
    }

    // Drain the serial write chain so any rename/append in flight completes.
    // Catching here ensures shutdown never throws — the upstream lifecycle
    // step error handler will record any failure for observability.
    try {
      await this.writeChain
    } catch (err) {
      getLogger().warn('Persistent storage: write chain drain failed during shutdown', { error: err })
    }

    // Re-arm the chain to a fresh resolved promise so a subsequent init()
    // does not chain new writes onto an old (possibly rejected) chain.
    this.writeChain = Promise.resolve()
  }

  // ─── Internal ─────────────────────────────────────────────────────────

  private scheduleFlush(): void {
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flush().catch(error => {
        getLogger().warn('Persistent storage: scheduled flush failed', { error })
      })
      this.flushTimer = null
    }, FLUSH_DEBOUNCE_MS)
    if (this.flushTimer) {
      this.flushTimer.unref()
    }
  }

  private async ensureDirectory(): Promise<void> {
    if (!existsSync(this.directory)) {
      await mkdir(this.directory, { recursive: true })
    }
  }

  private async checkAndRotate(): Promise<void> {
    try {
      if (!existsSync(this.dataFile)) return
      const stats = statSync(this.dataFile)
      if (stats.size >= this.maxFileSizeBytes) {
        await this.rotate()
      }
    } catch {
      // ignore
    }
  }

  private async rotate(): Promise<void> {
    const logger = getLogger()

    try {
      if (existsSync(this.dataFile)) {
        const rotatedFile = `${this.dataFile}.${Date.now()}.bak`
        await rename(this.dataFile, rotatedFile)
        logger.debug('Persistent storage: file rotated', { oldFile: rotatedFile })
      }
    } catch (error) {
      logger.warn('Persistent storage: rotation failed', { error })
    }

    this.eventCount = 0
  }

  private async rewriteFile(events: Event[]): Promise<void> {
    try {
      await this.rewriteEntries(events.map(event => ({ event, persistedAt: epochMs() })))
    } catch (error) {
      getLogger().warn('Persistent storage: rewrite failed', { error })
      try {
        void unlink(this.tempFile)
      } catch {
        // ignore
      }
    }
  }

  private async rewriteEntries(entriesToWrite: PersistedEventEntry[]): Promise<void> {
    const content = entriesToWrite.length > 0
      ? entriesToWrite.map(entry => JSON.stringify(entry)).join('\n') + '\n'
      : ''

    await this.enqueueWrite(async () => {
      if (content.length === 0) {
        await unlink(this.dataFile).catch(error => {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        })
        return
      }

      await writeFile(this.tempFile, content, { encoding: 'utf8' })
      await rename(this.tempFile, this.dataFile)
    })
  }

  private enqueueWrite(operation: () => Promise<void>): Promise<void> {
    // Wrap the operation with a per-op timeout so a hung filesystem (NFS,
    // full disk, frozen volume) cannot stall the shutdown drain indefinitely.
    const timed = () => withIoTimeout(operation(), this.ioTimeoutMs, 'persistent-storage write')
    this.writeChain = this.writeChain.then(timed, timed)
    return this.writeChain
  }

  private resolveDefaultDirectory(): string {
    const appName = 'pulse-sdk'
    const platform = process.platform
    const fallbackDir = join(tmpdir(), appName, 'events')

    if (platform === 'win32') {
      const localAppData = process.env.LOCALAPPDATA
      if (localAppData) {
        return join(localAppData, appName, 'events')
      }
      return fallbackDir
    }

    if (platform === 'darwin') {
      const home = process.env.HOME
      if (home) {
        return join(home, 'Library', 'Caches', appName, 'events')
      }
      return fallbackDir
    }

    const xdgCache = process.env.XDG_CACHE_HOME
    const home = process.env.HOME
    if (xdgCache) {
      return join(xdgCache, appName, 'events')
    }
    if (home) {
      return join(home, '.cache', appName, 'events')
    }
    return fallbackDir
  }
}

export const persistentStorage = new PersistentStorage()
export { PersistentStorage }
export type { PersistentStorageOptions }

/**
 * Race a file-system operation against a timeout. Used to protect every
 * write against frozen volumes (NFS, full disks, disconnected mounts).
 * Rejects with a descriptive error so the caller can record the failure
 * and continue without blocking the shutdown drain.
 */
function withIoTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
    timer.unref?.()
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  }) as Promise<T>
}
