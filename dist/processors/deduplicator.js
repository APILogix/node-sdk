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
class ErrorDeduplicator {
    entries = new Map();
    suppressionWindowMs = DEFAULT_SUPPRESSION_WINDOW_MS;
    maxEntries = DEFAULT_MAX_ENTRIES;
    cleanupTimer = null;
    suppressedCount = 0;
    initialized = false;
    configure(options = {}) {
        this.suppressionWindowMs = options.suppressionWindowMs ?? DEFAULT_SUPPRESSION_WINDOW_MS;
        this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
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
     */
    isDuplicate(fingerprint) {
        const now = epochMs();
        const existing = this.entries.get(fingerprint);
        if (!existing) {
            this.entries.set(fingerprint, { firstSeen: now, lastSeen: now, count: 1 });
            this.evictIfNecessary();
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
            oldestEntry: oldest,
            newestEntry: newest,
        };
    }
    /**
     * Reset all deduplication state.
     */
    reset() {
        this.entries.clear();
        this.suppressedCount = 0;
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
    evictIfNecessary() {
        if (this.entries.size <= this.maxEntries)
            return;
        const logger = getLogger();
        const toRemove = this.entries.size - this.maxEntries + Math.floor(this.maxEntries * 0.1);
        const sorted = Array.from(this.entries.entries())
            .sort((a, b) => a[1].lastSeen - b[1].lastSeen)
            .slice(0, toRemove);
        for (const [fp] of sorted) {
            this.entries.delete(fp);
        }
        logger.debug('Error dedup eviction', { evicted: sorted.length, remaining: this.entries.size });
    }
}
export const errorDeduplicator = new ErrorDeduplicator();
export { ErrorDeduplicator };
//# sourceMappingURL=deduplicator.js.map