/**
 * Error deduplication — suppresses duplicate errors within a configurable window.
 *
 * Tracks error fingerprints with timestamps and occurrence counts.
 * When the same fingerprint is seen within the suppression window,
 * the duplicate is suppressed and a counter is incremented.
 *
 * Thread-safe for concurrent access via Map operations.
 */
import { getLogger } from '../utils/logger.js';
import { epochMs } from '../utils/time.js';
const DEFAULT_SUPPRESSION_WINDOW_MS = 60_000; // 1 minute
const DEFAULT_MAX_ENTRIES = 5000;
const CLEANUP_INTERVAL_MS = 300_000; // 5 minutes
class LRUCache {
    capacity;
    cache = new Map();
    constructor(capacity) {
        this.capacity = capacity;
    }
    setCapacity(capacity) {
        this.capacity = capacity;
        while (this.cache.size > this.capacity) {
            this.cache.delete(this.cache.keys().next().value);
        }
    }
    get(key) {
        if (!this.cache.has(key))
            return undefined;
        const val = this.cache.get(key);
        this.cache.delete(key);
        this.cache.set(key, val);
        return val;
    }
    set(key, value) {
        if (this.cache.has(key)) {
            this.cache.delete(key);
        }
        else if (this.cache.size >= this.capacity) {
            this.cache.delete(this.cache.keys().next().value);
        }
        this.cache.set(key, value);
    }
    has(key) { return this.cache.has(key); }
    delete(key) { return this.cache.delete(key); }
    get size() { return this.cache.size; }
    clear() { this.cache.clear(); }
    entries() { return this.cache.entries(); }
    values() { return this.cache.values(); }
}
class ErrorDeduplicator {
    entries = new LRUCache(DEFAULT_MAX_ENTRIES);
    replaySeen = new LRUCache(1000);
    maxReplayEntries = 1000;
    suppressionWindowMs = DEFAULT_SUPPRESSION_WINDOW_MS;
    maxEntries = DEFAULT_MAX_ENTRIES;
    cleanupTimer = null;
    suppressedCount = 0;
    replayDuplicateCount = 0;
    initialized = false;
    configure(options = {}) {
        this.suppressionWindowMs = options.suppressionWindowMs ?? DEFAULT_SUPPRESSION_WINDOW_MS;
        this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
        this.entries.setCapacity(this.maxEntries);
    }
    start() {
        if (this.initialized)
            return;
        this.initialized = true;
        this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
        this.cleanupTimer.unref();
    }
    stop() {
        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer);
            this.cleanupTimer = null;
        }
        this.initialized = false;
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
    isDuplicate(fingerprint) {
        const now = epochMs();
        const existing = this.entries.get(fingerprint); // automatically moves to back
        if (!existing) {
            this.entries.set(fingerprint, { firstSeen: now, lastSeen: now, count: 1 });
            return false;
        }
        if (now - existing.lastSeen > this.suppressionWindowMs) {
            this.entries.set(fingerprint, { firstSeen: now, lastSeen: now, count: 1 });
            return false;
        }
        existing.lastSeen = now;
        existing.count += 1;
        this.suppressedCount += 1;
        return true;
    }
    /**
     * Get deduplication statistics.
     */
    getStats() {
        let oldest = null;
        let newest = null;
        for (const entry of this.entries.values()) {
            if (oldest === null || entry.firstSeen < oldest)
                oldest = entry.firstSeen;
            if (newest === null || entry.lastSeen > newest)
                newest = entry.lastSeen;
        }
        return {
            trackedErrors: this.entries.size,
            suppressedCount: this.suppressedCount,
            replayDuplicateCount: this.replayDuplicateCount,
            cacheSize: this.entries.size,
            cacheCapacity: this.maxEntries,
            oldestEntry: oldest,
            newestEntry: newest,
        };
    }
    /**
     * Check if a replayed event is a duplicate.
     * Uses a separate map keyed by replayId to avoid false suppression.
     */
    isReplayDuplicate(fingerprint, replayId) {
        const key = `${fingerprint}:${replayId}`;
        if (this.replaySeen.get(key) !== undefined) {
            this.replayDuplicateCount++;
            return true;
        }
        this.replaySeen.set(key, epochMs());
        return false;
    }
    /**
     * Reset all deduplication state. Also stops the cleanup timer so a
     * subsequent start() can re-arm it cleanly. Idempotent.
     */
    reset() {
        this.stop();
        this.entries.clear();
        this.replaySeen.clear();
        this.suppressedCount = 0;
        this.replayDuplicateCount = 0;
    }
    cleanup() {
        const now = epochMs();
        const logger = getLogger();
        let cleaned = 0;
        for (const [fp, entry] of this.entries.entries()) {
            if (now - entry.lastSeen > this.suppressionWindowMs) {
                this.entries.delete(fp);
                cleaned++;
            }
        }
        if (cleaned > 0) {
            logger.debug('Error dedup cleanup', { cleanedEntries: cleaned, remaining: this.entries.size });
        }
    }
}
export const errorDeduplicator = new ErrorDeduplicator();
export { ErrorDeduplicator };
//# sourceMappingURL=deduplicator.js.map