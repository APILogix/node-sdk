/**
 * Error deduplication — suppresses duplicate errors within a configurable window.
 *
 * Tracks error fingerprints with timestamps and occurrence counts.
 * When the same fingerprint is seen within the suppression window,
 * the duplicate is suppressed and a counter is incremented.
 *
 * Thread-safe for concurrent access via Map operations.
 */

import { getLogger } from '../utils/logger.js'
import { epochMs } from '../utils/time.js'

interface DedupEntry {
  firstSeen: number
  lastSeen: number
  count: number
}

const DEFAULT_SUPPRESSION_WINDOW_MS = 60_000 // 1 minute
const DEFAULT_MAX_ENTRIES = 5000
const CLEANUP_INTERVAL_MS = 300_000 // 5 minutes

class LRUCache<K, V> {
  private cache = new Map<K, V>()
  constructor(private capacity: number) {}
  setCapacity(capacity: number) {
    this.capacity = capacity
    while (this.cache.size > this.capacity) {
      this.cache.delete(this.cache.keys().next().value!)
    }
  }
  get(key: K): V | undefined {
    if (!this.cache.has(key)) return undefined
    const val = this.cache.get(key)!
    this.cache.delete(key)
    this.cache.set(key, val)
    return val
  }
  set(key: K, value: V): void {
    if (this.cache.has(key)) {
      this.cache.delete(key)
    } else if (this.cache.size >= this.capacity) {
      this.cache.delete(this.cache.keys().next().value!)
    }
    this.cache.set(key, value)
  }
  has(key: K): boolean { return this.cache.has(key) }
  delete(key: K): boolean { return this.cache.delete(key) }
  get size(): number { return this.cache.size }
  clear(): void { this.cache.clear() }
  entries(): IterableIterator<[K, V]> { return this.cache.entries() }
  values(): IterableIterator<V> { return this.cache.values() }
}

class ErrorDeduplicator {
  private entries = new LRUCache<string, DedupEntry>(DEFAULT_MAX_ENTRIES)
  private replaySeen = new LRUCache<string, number>(1000)
  private readonly maxReplayEntries = 1000
  private suppressionWindowMs: number = DEFAULT_SUPPRESSION_WINDOW_MS
  private maxEntries: number = DEFAULT_MAX_ENTRIES
  private cleanupTimer: ReturnType<typeof setInterval> | null = null
  private suppressedCount = 0
  private replayDuplicateCount = 0
  private initialized = false

  configure(options: { suppressionWindowMs?: number; maxEntries?: number } = {}): void {
    this.suppressionWindowMs = options.suppressionWindowMs ?? DEFAULT_SUPPRESSION_WINDOW_MS
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES
    this.entries.setCapacity(this.maxEntries)
  }

  start(): void {
    if (this.initialized) return
    this.initialized = true
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS)
    this.cleanupTimer.unref()
  }

  stop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = null
    }
    this.initialized = false
  }

  /**
   * Check if an error fingerprint should be suppressed.
   * Returns true if the error is a duplicate within the suppression window.
   *
   * Map insertion order is preserved by ECMAScript spec, so we can rely on
   * `entries.keys().next()` to give us the oldest entry (insertion order),
   * which correlates closely with `lastSeen` because we re-insert on
   * window expiry. This makes eviction O(k) instead of O(n log n).
   */
  isDuplicate(fingerprint: string): boolean {
    const now = epochMs()
    const existing = this.entries.get(fingerprint) // automatically moves to back

    if (!existing) {
      this.entries.set(fingerprint, { firstSeen: now, lastSeen: now, count: 1 })
      return false
    }

    if (now - existing.firstSeen > this.suppressionWindowMs) {
      this.entries.set(fingerprint, { firstSeen: now, lastSeen: now, count: 1 })
      return false
    }

    existing.lastSeen = now
    existing.count += 1
    this.suppressedCount += 1
    return true
  }

  delete(fingerprint: string): boolean {
    return this.entries.delete(fingerprint)
  }

  /**
   * Get deduplication statistics.
   */
  getStats(): {
    trackedErrors: number
    suppressedCount: number
    replayDuplicateCount: number
    cacheSize: number
    cacheCapacity: number
    oldestEntry: number | null
    newestEntry: number | null
  } {
    let oldest: number | null = null
    let newest: number | null = null

    for (const entry of this.entries.values()) {
      if (oldest === null || entry.firstSeen < oldest) oldest = entry.firstSeen
      if (newest === null || entry.lastSeen > newest) newest = entry.lastSeen
    }

    return {
      trackedErrors: this.entries.size,
      suppressedCount: this.suppressedCount,
      replayDuplicateCount: this.replayDuplicateCount,
      cacheSize: this.entries.size,
      cacheCapacity: this.maxEntries,
      oldestEntry: oldest,
      newestEntry: newest,
    }
  }

  /**
   * Check if a replayed event is a duplicate.
   * Uses a separate map keyed by replayId to avoid false suppression.
   */
  isReplayDuplicate(fingerprint: string, replayId: string): boolean {
    const key = `${fingerprint}:${replayId}`

    if (this.replaySeen.get(key) !== undefined) {
      this.replayDuplicateCount++
      return true
    }

    this.replaySeen.set(key, epochMs())
    return false
  }

  /**
   * Reset all deduplication state. Also stops the cleanup timer so a
   * subsequent start() can re-arm it cleanly. Idempotent.
   */
  reset(): void {
    this.stop()
    this.entries.clear()
    this.replaySeen.clear()
    this.suppressedCount = 0
    this.replayDuplicateCount = 0
  }

  private cleanup(): void {
    const now = epochMs()
    const logger = getLogger()
    let cleaned = 0

    for (const [fp, entry] of this.entries.entries()) {
      if (now - entry.lastSeen > this.suppressionWindowMs) {
        this.entries.delete(fp)
        cleaned++
      }
    }

    if (cleaned > 0) {
      logger.debug('Error dedup cleanup', { cleanedEntries: cleaned, remaining: this.entries.size })
    }
  }
}

class TraceDeduplicator {
  private entries = new LRUCache<string, number>(10_000)
  private suppressionWindowMs = 60_000

  configure(options: { suppressionWindowMs?: number; maxEntries?: number } = {}): void {
    if (options.suppressionWindowMs !== undefined) this.suppressionWindowMs = options.suppressionWindowMs
    if (options.maxEntries !== undefined) this.entries.setCapacity(options.maxEntries)
  }

  isDuplicate(traceId: string): boolean {
    const now = epochMs()
    const lastSeen = this.entries.get(traceId)
    if (lastSeen !== undefined && now - lastSeen < this.suppressionWindowMs) {
      return true
    }
    this.entries.set(traceId, now)
    return false
  }

  reset(): void {
    this.entries.clear()
  }
}

export const errorDeduplicator = new ErrorDeduplicator()
export const traceDeduplicator = new TraceDeduplicator()
export { ErrorDeduplicator, TraceDeduplicator }

