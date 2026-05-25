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

class ErrorDeduplicator {
  private entries = new Map<string, DedupEntry>()
  private replaySeen = new Map<string, number>()
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
    const existing = this.entries.get(fingerprint)

    if (!existing) {
      this.entries.set(fingerprint, { firstSeen: now, lastSeen: now, count: 1 })
      this.evictIfNecessary()
      return false
    }

    if (now - existing.lastSeen > this.suppressionWindowMs) {
      // Re-insert to refresh insertion-order position (cheap O(1)).
      this.entries.delete(fingerprint)
      this.entries.set(fingerprint, { firstSeen: now, lastSeen: now, count: 1 })
      return false
    }

    existing.lastSeen = now
    existing.count += 1
    this.suppressedCount += 1
    return true
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

    if (this.replaySeen.has(key)) {
      this.replayDuplicateCount++
      return true
    }

    // Bound the replay seen map
    if (this.replaySeen.size >= this.maxReplayEntries) {
      // Evict oldest 10%
      const toRemove = Math.floor(this.maxReplayEntries * 0.1)
      const keys = this.replaySeen.keys()
      for (let i = 0; i < toRemove; i++) {
        const result = keys.next()
        if (result.done) break
        this.replaySeen.delete(result.value)
      }
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

  /**
   * Evict the oldest entries (by insertion order) when the cache exceeds
   * its capacity. Map iteration is insertion-ordered per the ECMAScript
   * spec, so this is O(k) where k is the eviction count — far cheaper than
   * the previous sort-based eviction.
   */
  private evictIfNecessary(): void {
    if (this.entries.size <= this.maxEntries) return

    const logger = getLogger()
    const toRemove = this.entries.size - this.maxEntries + Math.floor(this.maxEntries * 0.1)

    let evicted = 0
    const iterator = this.entries.keys()
    while (evicted < toRemove) {
      const next = iterator.next()
      if (next.done) break
      this.entries.delete(next.value)
      evicted++
    }

    logger.debug('Error dedup eviction', { evicted, remaining: this.entries.size })
  }
}

export const errorDeduplicator = new ErrorDeduplicator()
export { ErrorDeduplicator }
