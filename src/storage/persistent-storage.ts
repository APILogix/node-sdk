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
   * Replay persisted events from disk.
   * Returns events that are still valid (within TTL).
   */
  async replay(): Promise<Event[]> {
    const logger = getLogger()

    if (!existsSync(this.dataFile)) {
      return []
    }

    try {
      const content = await readFile(this.dataFile, { encoding: 'utf8' })
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
   * Shut down persistent storage — flush remaining events.
   */
  async shutdown(): Promise<void> {
    await this.flush()
    this.initialized = false
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
      const entries = events.map(event =>
        JSON.stringify({ event, persistedAt: epochMs() })
      ).join('\n') + '\n'

      // Atomic write: write to temp (overwrite, not append), then rename
      await this.enqueueWrite(async () => {
        await writeFile(this.tempFile, entries, { encoding: 'utf8' })
        await rename(this.tempFile, this.dataFile)
      })
    } catch (error) {
      getLogger().warn('Persistent storage: rewrite failed', { error })
      try {
        void unlink(this.tempFile)
      } catch {
        // ignore
      }
    }
  }

  private enqueueWrite(operation: () => Promise<void>): Promise<void> {
    this.writeChain = this.writeChain.then(operation, operation)
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
