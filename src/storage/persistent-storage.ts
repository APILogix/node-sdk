/**
 * Persistent storage — file-based event persistence across restarts.
 *
 * ## Persistence model: fallback-only
 *
 * This module does NOT persist every event the SDK emits. It is a *fallback*
 * for events that were never confirmed delivered to the backend. Concretely:
 *
 *   - The event-pipeline does NOT call `persist()` on success.
 *   - The transport layer (`BatchManager`) calls `persist()` ONLY when an
 *     HTTP send fails (network error, retry-eligible HTTP status).
 *   - On graceful shutdown, the lifecycle drains any events still queued
 *     in transport into `persist()` so they survive a restart.
 *   - On successful HTTP delivery (2xx response), the transport calls
 *     `discard(events)` to remove the corresponding entries from disk.
 *
 * This is the same posture the OpenTelemetry collector and Sentry's envelope
 * persistence use. The earlier "persist on every successful capture" model
 * caused every restart to replay events that were already delivered, which
 * produced duplicate billing, alert amplification, and analytics corruption.
 *
 * ## Delivery semantics
 *
 *   PENDING (in pipeline)
 *     │
 *     ▼
 *   QUEUED (in BatchManager)         ── crash here ─► event LOST (window: <flush interval)
 *     │
 *     ▼
 *   SENDING (HTTP in flight)
 *     │
 *     ├─► FAIL ─► persist() ─► QUEUED again on next batcher tick
 *     │
 *     └─► OK ─► discard() ─► REMOVED
 *
 * The "window" between QUEUED and SENDING is the only place where an event
 * can be lost without being persisted. This is bounded by the BatchManager's
 * `maxWaitTimeMs` (1–10 seconds depending on route). For critical telemetry
 * (errors), the route's `maxWaitTimeMs` is 1 second and `minBatchSize` is 1,
 * so a single error is sent within ~1 second of capture. Persisting *every*
 * event eagerly to close this window was the change that produced the
 * duplicate-replay bug — the cure was worse than the disease.
 *
 * ## At-least-once delivery
 *
 * This module provides at-least-once delivery semantics. There is one
 * unavoidable duplicate scenario: if the backend successfully receives a
 * batch but the response is lost (TCP reset between server's write and
 * client's read), the client will retry. The backend MUST dedupe by
 * `eventId` to guarantee exactly-once. Every event in this SDK has a
 * cryptographically-random UUIDv4 `eventId` that is preserved across
 * persistence, retries, and replays — so backend dedup is straightforward.
 *
 * ## File format and crash safety
 *
 * Events are written to a local file as newline-delimited JSON (NDJSON).
 * Writes are serialized through a single async chain (`writeChain`) so two
 * concurrent persists cannot interleave on the same file descriptor.
 * Compaction (`discard`, `rewriteFile`) writes to a `.tmp` file and atomic-
 * renames it into place — a crash during write leaves either the old file
 * or the new file, never a corrupt one. `replay()` defensively skips
 * malformed lines so a partial write at the tail of the file (the only
 * unprotected window) doesn't poison replay.
 */

import { existsSync, unlinkSync, statSync, readdirSync, createReadStream, createWriteStream } from 'fs'
import { appendFile, copyFile, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'fs/promises'
import { createInterface } from 'readline'
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
/**
 * Events JSON-stringified per event-loop turn during flush. Keeps the
 * synchronous serialization burst bounded so the host app stays responsive.
 */
const FLUSH_STRINGIFY_CHUNK_SIZE = 200
const DEFAULT_IO_TIMEOUT_MS = 5_000 // Per file-operation timeout — protects against frozen filesystems.

interface PersistentStorageOptions {
  /** Directory to store persisted events. Defaults to OS temp dir. */
  directory?: string | undefined
  /** Whether persistence is enabled. When false, disk operations are completely bypassed. Default: true. */
  enabled?: boolean | undefined
  /** API key hash for unique file naming. */
  apiKeyHash?: string | undefined
  /** Maximum file size before rotation. Default: 10MB. */
  maxFileSizeBytes?: number | undefined
  /** Maximum events to persist. Default: 10000. */
  maxEvents?: number | undefined
  /** Event TTL in milliseconds. Default: 24 hours. */
  eventTtlMs?: number | undefined
  /**
   * Per file-operation timeout in milliseconds. Default: 5000.
   * Protects against frozen filesystems (NFS hangs, full disks, etc.) that
   * would otherwise block the shutdown drain indefinitely.
   */
  ioTimeoutMs?: number | undefined
}

interface PersistedEventEntry {
  event: Event
  persistedAt: number
}

class PersistentStorage {
  private directoryPath: string = ''
  private filePrefix: string = 'pulse-events'
  private dataFile: string = ''
  private enabled: boolean = true
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
  /** Events removed from disk after backend acknowledgement (successful send). */
  private totalDiscarded = 0
  /** Number of replay() calls completed (one per init). */
  private replayCount = 0
  /** Epoch ms of the most recent replay() completion. */
  private lastReplayAt = 0
  private writeChain: Promise<void> = Promise.resolve()
  private persistedIds = new Set<string>()

  configure(options: PersistentStorageOptions = {}): void {
    if (options.enabled !== undefined) {
      this.enabled = options.enabled
    }
    this.directoryPath = options.directory ?? this.resolveDefaultDirectory()
    this.maxFileSizeBytes = options.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE_BYTES
    this.maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS
    this.eventTtlMs = options.eventTtlMs ?? DEFAULT_EVENT_TTL_MS
    this.ioTimeoutMs = options.ioTimeoutMs ?? DEFAULT_IO_TIMEOUT_MS

    const suffix = options.apiKeyHash ? `-${options.apiKeyHash.slice(0, 8)}` : ''
    this.filePrefix = `pulse-events${suffix}`
    this.dataFile = join(this.directoryPath, `${this.filePrefix}-${process.pid}.ndjson`)
  }

  private createTempFilePath(): string {
    const randomSuffix = Math.random().toString(36).slice(2)
    return join(this.directoryPath, `.${this.filePrefix}-${process.pid}-${Date.now()}-${randomSuffix}.tmp`)
  }

  async init(): Promise<Event[]> {
    if (this.initialized) return []
    if (!this.enabled) {
      this.initialized = false
      return []
    }

    const logger = getLogger()

    try {
      await this.ensureDirectory()
    } catch (error) {
      this.initialized = false
      const code = (error as NodeJS.ErrnoException)?.code
      if (code === 'EROFS' || code === 'EACCES' || code === 'EPERM') {
        logger.debug('Persistent storage: filesystem is read-only or inaccessible, running in pure in-memory mode', {
          directory: this.directoryPath,
          code,
        })
      } else {
        logger.warn('Persistent storage: failed to initialize directory, disabling persistence', {
          directory: this.directoryPath,
          error,
        })
      }
      return []
    }

    this.initialized = true

    const replayed = await this.replay()
    this.totalReplayed = replayed.length

    logger.info('Persistent storage initialized', {
      directory: this.directoryPath,
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
   * storage was never initialized, is disabled, or has already been shut down.
   */
  persist(event: Event): void {
    if (!this.initialized || !this.enabled) return

    this.buffer.push(event)
    this.eventCount++

    if (this.eventCount >= this.maxEvents) {
      void this.rotate()
    }

    this.scheduleFlush()
  }

  /**
   * Whether persistent storage has been initialized and has not been shut
   * down or disabled. Callers (typically the transport layer) check this before
   * persisting on send failure so they can degrade gracefully when
   * persistence is unavailable (e.g., the SDK is being shut down or serverless).
   */
  get isInitialized(): boolean {
    return this.initialized && this.enabled
  }

  /** The configured or resolved directory path where events are persisted. */
  get directory(): string {
    return this.directoryPath
  }

  /** The path to the active events NDJSON data file. */
  get dataFilePath(): string {
    return this.dataFile
  }

  /**
   * Persist a whole batch of events in one call.
   *
   * Equivalent to calling `persist(event)` for every event but avoids N
   * separate buffer pushes plus N separate `scheduleFlush` calls. Used by
   * the transport layer when an entire batch fails to send and must be
   * durably retained for replay.
   */
  persistBatch(events: readonly Event[]): void {
    if (!this.initialized || !this.enabled || events.length === 0) return

    for (const event of events) {
      this.buffer.push(event)
      this.eventCount++
    }

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

    // Atomically snapshot and drain the buffer so concurrent flush() calls
    // or newly arriving events do not duplicate or get overwritten.
    const toFlush = this.buffer
    this.buffer = []

    const logger = getLogger()
    const entries: string[] = []

    // Stringify in chunks, yielding to the event loop between them — a
    // large buffer serialized in one synchronous loop would block the
    // host application's event loop for the entire duration.
    let processed = 0
    for (const event of toFlush) {
      const entry: PersistedEventEntry = {
        event,
        persistedAt: epochMs(),
      }
      entries.push(JSON.stringify(entry))
      processed++
      if (processed % FLUSH_STRINGIFY_CHUNK_SIZE === 0) {
        await new Promise<void>(resolve => setImmediate(resolve))
      }
    }

    try {
      await this.checkAndRotate()

      const content = entries.join('\n') + '\n'
      await this.enqueueWrite(() => appendFile(this.dataFile, content, { encoding: 'utf8', mode: 0o600 }))

      this.totalPersisted += toFlush.length
      for (const event of toFlush) {
        if (event.eventId) {
          this.persistedIds.add(event.eventId)
        }
      }
      if (this.persistedIds.size > this.maxEvents * 2) {
        const excess = this.persistedIds.size - this.maxEvents * 2
        let evicted = 0
        for (const id of this.persistedIds.keys()) {
          this.persistedIds.delete(id)
          evicted++
          if (evicted >= excess) break
        }
      }
    } catch (error) {
      this.writeErrors++
      // Restore unflushed events to the head of the buffer so they are not lost
      this.buffer.unshift(...toFlush)
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
   *
   * This is the ACK side of the persistence lifecycle. Called by the
   * transport layer ONLY after the backend returns 2xx for a batch.
   * Any events with matching `eventId` are stripped from both the
   * in-memory buffer and the on-disk NDJSON file so they cannot be
   * replayed on the next process start.
   *
   * The implementation reads, filters, and rewrites the data file
   * atomically (tmp file + rename). For very high event rates this is
   * O(N) per call, which is acceptable for batch ACKs (one call per
   * batch of ~100-500 events) but would be a problem if called per
   * event. The transport layer batches discards naturally.
   */
  async discard(events: readonly Event[]): Promise<void> {
    if (events.length === 0) return

    const deliveredIds = new Set(
      events
        .map(event => event.eventId)
        .filter((eventId): eventId is string => typeof eventId === 'string' && eventId.length > 0)
    )
    if (deliveredIds.size === 0) return

    const beforeBuffer = this.buffer.length
    this.buffer = this.buffer.filter(event => !deliveredIds.has(event.eventId ?? ''))
    const removedFromBuffer = beforeBuffer - this.buffer.length

    // Fast-path: Check if any delivered event ID was actually written to persistent storage.
    // In normal operation, batches are delivered without ever being written to disk.
    // If no delivered event was persisted to disk, avoid expensive readFile/parse/rewrite.
    let hasPersistedDelivered = false
    for (const id of deliveredIds) {
      if (this.persistedIds.has(id)) {
        hasPersistedDelivered = true
        break
      }
    }

    if (!hasPersistedDelivered || !existsSync(this.dataFile)) {
      // Nothing on disk or delivered events were not persisted — discard count is purely the buffer trim.
      this.totalDiscarded += removedFromBuffer
      return
    }

    try {
      await this.enqueueWrite(async () => {
        if (!existsSync(this.dataFile)) return

        const tempFile = this.createTempFilePath()
        let retainedCount = 0
        let removedFromDisk = 0

        try {
          const readStream = createReadStream(this.dataFile, { encoding: 'utf8', highWaterMark: 64 * 1024 })
          const writeStream = createWriteStream(tempFile, { encoding: 'utf8', mode: 0o600 })
          const rl = createInterface({ input: readStream, crlfDelay: Infinity })

          let lineCounter = 0
          for await (const line of rl) {
            const trimmed = line.trim()
            if (trimmed.length === 0) continue

            // Fast regex heuristic to extract eventId without full JSON.parse
            const match = trimmed.match(/"eventId"\s*:\s*"([^"]+)"/)
            let eid: string | undefined = match ? match[1] : undefined

            if (!eid) {
              try {
                const entry: PersistedEventEntry = JSON.parse(trimmed)
                eid = entry.event?.eventId
              } catch {
                // Drop malformed lines while compacting acknowledged events.
                continue
              }
            }

            if (eid && deliveredIds.has(eid)) {
              removedFromDisk++
              this.persistedIds.delete(eid)
            } else {
              writeStream.write(trimmed + '\n')
              retainedCount++
            }

            lineCounter++
            if (lineCounter % 250 === 0) {
              await new Promise<void>(resolve => setImmediate(resolve))
            }
          }

          await new Promise<void>((resolve, reject) => {
            writeStream.end(() => resolve())
            writeStream.on('error', reject)
          })

          if (retainedCount === 0) {
            await unlink(this.dataFile).catch(() => {})
            await unlink(tempFile).catch(() => {})
            this.persistedIds.clear()
          } else {
            await safeAtomicRename(tempFile, this.dataFile)
          }

          this.eventCount = retainedCount + this.buffer.length
          this.totalDiscarded += removedFromBuffer + removedFromDisk
        } catch (streamErr) {
          await unlink(tempFile).catch(() => {})
          throw streamErr
        }
      })
    } catch (error) {
      getLogger().warn('Persistent storage: discard failed', { error })
    }
  }

  /**
   * Replay persisted events from disk.
   * Returns events that are still valid (within TTL).
   *
   * Multi-process / cluster safe:
   * 1. Inspects the directory for files belonging to this prefix.
   * 2. Replays legacy file (pulse-events.ndjson / pulse-events-<hash>.ndjson) if present.
   * 3. Replays files from dead processes (PIDs that are no longer alive).
   * 4. Exclusively claims candidate files via atomic rename before reading to
   *    prevent multiple workers from racing or duplicating replay batches.
   */
  async replay(): Promise<Event[]> {
    const logger = getLogger()
    const now = epochMs()
    const validEvents: Event[] = []
    let totalLines = 0

    if (!existsSync(this.directoryPath)) {
      return []
    }

    try {
      const dirEntries = await readdir(this.directoryPath).catch(() => [] as string[])
      const prefix = this.filePrefix

      // Match legacy un-pid'd files, orphaned pid files, and rotated (.bak) files for this apiKeyHash
      interface CandidateFile {
        name: string
        orderTimestamp: number
      }
      const candidateList: CandidateFile[] = []
      const filePattern = new RegExp(`^${prefix}(?:-(\\d+))?\\.ndjson(?:\\.(\\d+)\\.bak)?$`)

      for (const entry of dirEntries) {
        if (entry.startsWith('.')) continue

        const match = entry.match(filePattern)
        if (!match) continue

        const pidStr = match[1]
        const bakTimestampStr = match[2]

        if (pidStr !== undefined) {
          const filePid = parseInt(pidStr, 10)
          if (filePid !== process.pid && isPidAlive(filePid)) {
            // Belongs to an active sibling process; do not claim
            continue
          }
        }

        // Chronological order: older rotated backups first, active (.ndjson) last
        const orderTimestamp = bakTimestampStr !== undefined ? parseInt(bakTimestampStr, 10) : Number.MAX_SAFE_INTEGER
        candidateList.push({ name: entry, orderTimestamp })
      }

      // Sort candidate files chronologically so older rotated segments are replayed before active files
      candidateList.sort((a, b) => a.orderTimestamp - b.orderTimestamp)
      const candidateFiles = candidateList.map(c => c.name)

      for (const fileName of candidateFiles) {
        const fullPath = join(this.directoryPath, fileName)
        const randomToken = Math.random().toString(36).slice(2)
        const claimPath = join(this.directoryPath, `.${fileName}.claim-${process.pid}-${Date.now()}-${randomToken}.tmp`)

        let claimed = false
        try {
          await rename(fullPath, claimPath)
          claimed = true
        } catch {
          // Another worker claimed it or file missing/locked
          continue
        }

        if (!claimed) continue

        try {
          const readStream = createReadStream(claimPath, { encoding: 'utf8', highWaterMark: 64 * 1024 })
          const rl = createInterface({ input: readStream, crlfDelay: Infinity })
          let lineCounter = 0

          for await (const line of rl) {
            const trimmed = line.trim()
            if (trimmed.length === 0) continue
            totalLines++

            try {
              const entry: PersistedEventEntry = JSON.parse(trimmed)
              if (now - entry.persistedAt > this.eventTtlMs) {
                this.totalExpired++
                continue
              }
              validEvents.push(entry.event)
            } catch {
              // Skip malformed lines
              continue
            }

            lineCounter++
            if (lineCounter % 250 === 0) {
              await new Promise<void>(resolve => setImmediate(resolve))
            }
          }
        } finally {
          await unlink(claimPath).catch(() => {})
        }
      }

      this.replayCount++
      this.lastReplayAt = epochMs()

      logger.info('Persistent storage: replay complete', {
        totalLines,
        validEvents: validEvents.length,
        expiredEvents: this.totalExpired,
        replayCount: this.replayCount,
        note: validEvents.length > 0
          ? 'Replayed events were undelivered at last shutdown — backend MUST dedupe by eventId'
          : 'No undelivered events to replay',
      })

      return validEvents
    } catch (error) {
      logger.warn('Persistent storage: replay failed', { error })
      return []
    }
  }

  /**
   * Get storage statistics for operational dashboards / health endpoints.
   *
   * The `totalDiscarded` and `replayCount` counters are the key signals for
   * verifying the persistence lifecycle is working as designed:
   *
   *   - `totalDiscarded > 0` confirms the transport is ACKing successful
   *     batches — events ARE being removed from disk after delivery.
   *   - `replayCount` is the number of process restarts that found
   *     undelivered events (i.e. previous shutdowns that lost in-flight
   *     work). High values suggest unstable transport or aggressive process
   *     termination.
   */
  getStats(): {
    initialized: boolean
    eventCount: number
    bufferedEvents: number
    totalPersisted: number
    totalReplayed: number
    totalExpired: number
    totalDiscarded: number
    replayCount: number
    lastReplayAt: number
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
      totalDiscarded: this.totalDiscarded,
      replayCount: this.replayCount,
      lastReplayAt: this.lastReplayAt,
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
    this.persistedIds.clear()

    try {
      if (existsSync(this.dataFile)) {
        unlinkSync(this.dataFile)
      }
      if (existsSync(this.directoryPath)) {
        const files = readdirSync(this.directoryPath)
        for (const f of files) {
          if (f.startsWith(this.filePrefix) || f.startsWith(`.${this.filePrefix}`)) {
            try { unlinkSync(join(this.directoryPath, f)) } catch {}
          }
        }
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
    if (!existsSync(this.directoryPath)) {
      await mkdir(this.directoryPath, { recursive: true, mode: 0o700 })
    }
    // Writability probe: verifies the directory is actually writable (not EROFS / EACCES)
    const probeFile = join(this.directoryPath, `.pulse-probe-${process.pid}-${Date.now()}.tmp`)
    await writeFile(probeFile, '', { encoding: 'utf8' })
    await unlink(probeFile).catch(() => {})
  }

  private async checkAndRotate(): Promise<void> {
    try {
      // Async stat — the previous existsSync + statSync pair issued two
      // blocking syscalls on every flush. `stat` throws ENOENT when the
      // file doesn't exist yet, which the catch treats as "nothing to
      // rotate".
      const stats = await stat(this.dataFile)
      if (stats.size >= this.maxFileSizeBytes) {
        await this.rotate()
      }
    } catch {
      // File missing or unreadable — nothing to rotate.
    }
  }

  private async rotate(): Promise<void> {
    const logger = getLogger()

    try {
      if (existsSync(this.dataFile)) {
        const rotatedFile = `${this.dataFile}.${Date.now()}.bak`
        await safeAtomicRename(this.dataFile, rotatedFile)
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

      const tempFile = this.createTempFilePath()
      try {
        await writeFile(tempFile, content, { encoding: 'utf8', mode: 0o600 })
        await safeAtomicRename(tempFile, this.dataFile)
      } finally {
        await unlink(tempFile).catch(() => {})
      }
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
    const appName = 'telemetry-sdk'
    const platform = process.platform
    const fallbackDir = join(tmpdir(), appName, 'events')

    // In serverless environments (AWS Lambda, GCP Cloud Functions, Azure Functions, Vercel),
    // /tmp is the only writable directory. HOME (/var/task, /root, /workspace) is read-only.
    if (this.isServerlessEnvironment()) {
      return fallbackDir
    }

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
    if (home && home !== '/var/task' && home !== '/root') {
      return join(home, '.cache', appName, 'events')
    }
    return fallbackDir
  }

  private isServerlessEnvironment(): boolean {
    return Boolean(
      process.env.AWS_LAMBDA_FUNCTION_NAME ||
      process.env.K_SERVICE ||
      process.env.FUNCTIONS_WORKER_RUNTIME ||
      process.env.VERCEL ||
      process.env.NOW_REGION
    )
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

/**
 * Windows-safe atomic rename with retry and fallback.
 * On Windows (NTFS), destination files locked by indexers/antivirus or brief
 * open handles throw EPERM/EBUSY. Retries with backoff and falls back to
 * copy+unlink to guarantee non-crashing compaction.
 */
async function safeAtomicRename(source: string, target: string): Promise<void> {
  const isWindows = process.platform === 'win32'
  const maxAttempts = isWindows ? 5 : 2
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      await rename(source, target)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES' || code === 'EEXIST') {
        if (attempt < maxAttempts - 1) {
          if (isWindows) {
            await unlink(target).catch(() => {})
          }
          await new Promise(r => setTimeout(r, (attempt + 1) * 10))
          continue
        }
        await copyFile(source, target)
        await unlink(source).catch(() => {})
        return
      }
      throw err
    }
  }
}

function isPidAlive(pid: number): boolean {
  if (pid <= 0 || !Number.isInteger(pid)) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

