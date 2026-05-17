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
import { existsSync, mkdirSync, readFileSync, appendFileSync, renameSync, unlinkSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { createHash } from 'crypto';
import { getLogger } from '../utils/logger.js';
import { epochMs } from '../utils/time.js';
const DEFAULT_MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10MB
const DEFAULT_MAX_EVENTS = 10000;
const DEFAULT_EVENT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const FLUSH_DEBOUNCE_MS = 1000;
class PersistentStorage {
    directory = '';
    dataFile = '';
    tempFile = '';
    maxFileSizeBytes = DEFAULT_MAX_FILE_SIZE_BYTES;
    maxEvents = DEFAULT_MAX_EVENTS;
    eventTtlMs = DEFAULT_EVENT_TTL_MS;
    buffer = [];
    flushTimer = null;
    eventCount = 0;
    initialized = false;
    writeErrors = 0;
    totalPersisted = 0;
    totalReplayed = 0;
    totalExpired = 0;
    configure(options = {}) {
        this.directory = options.directory ?? this.resolveDefaultDirectory();
        this.maxFileSizeBytes = options.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE_BYTES;
        this.maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS;
        this.eventTtlMs = options.eventTtlMs ?? DEFAULT_EVENT_TTL_MS;
        const suffix = options.apiKeyHash ? `-${options.apiKeyHash.slice(0, 8)}` : '';
        this.dataFile = join(this.directory, `pulse-events${suffix}.ndjson`);
        this.tempFile = join(this.directory, `pulse-events${suffix}.ndjson.tmp`);
    }
    async init() {
        if (this.initialized)
            return [];
        this.initialized = true;
        const logger = getLogger();
        try {
            this.ensureDirectory();
        }
        catch (error) {
            logger.warn('Persistent storage: failed to create directory, disabling persistence', {
                directory: this.directory,
                error,
            });
            return [];
        }
        const replayed = this.replay();
        this.totalReplayed = replayed.length;
        logger.info('Persistent storage initialized', {
            directory: this.directory,
            replayedEvents: replayed.length,
            maxEvents: this.maxEvents,
            ttlHours: this.eventTtlMs / (60 * 60 * 1000),
        });
        return replayed;
    }
    /**
     * Queue an event for persistence. Events are batched and flushed periodically.
     */
    persist(event) {
        if (!this.initialized)
            return;
        this.buffer.push(event);
        this.eventCount++;
        if (this.eventCount >= this.maxEvents) {
            this.rotate();
        }
        this.scheduleFlush();
    }
    /**
     * Force-flush all buffered events to disk immediately.
     */
    flush() {
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
        if (this.buffer.length === 0)
            return;
        const logger = getLogger();
        const entries = [];
        for (const event of this.buffer) {
            const entry = {
                event,
                persistedAt: epochMs(),
            };
            entries.push(JSON.stringify(entry));
        }
        try {
            this.checkAndRotate();
            const content = entries.join('\n') + '\n';
            appendFileSync(this.dataFile, content, { encoding: 'utf8' });
            this.totalPersisted += this.buffer.length;
            this.buffer = [];
        }
        catch (error) {
            this.writeErrors++;
            logger.warn('Persistent storage: write failed', {
                error,
                writeErrors: this.writeErrors,
                bufferedEvents: this.buffer.length,
            });
            if (this.writeErrors >= 10) {
                logger.error('Persistent storage: too many write errors, disabling', {
                    writeErrors: this.writeErrors,
                });
                this.initialized = false;
            }
        }
    }
    /**
     * Replay persisted events from disk.
     * Returns events that are still valid (within TTL).
     */
    replay() {
        const logger = getLogger();
        if (!existsSync(this.dataFile)) {
            return [];
        }
        try {
            const content = readFileSync(this.dataFile, { encoding: 'utf8' });
            const lines = content.split('\n').filter(line => line.trim().length > 0);
            const now = epochMs();
            const validEvents = [];
            for (const line of lines) {
                try {
                    const entry = JSON.parse(line);
                    if (now - entry.persistedAt > this.eventTtlMs) {
                        this.totalExpired++;
                        continue;
                    }
                    validEvents.push(entry.event);
                }
                catch {
                    // Skip malformed lines
                    continue;
                }
            }
            // Rewrite file with only valid events (cleanup expired)
            if (this.totalExpired > 0) {
                this.rewriteFile(validEvents);
            }
            logger.debug('Persistent storage: replay complete', {
                totalLines: lines.length,
                validEvents: validEvents.length,
                expiredEvents: this.totalExpired,
            });
            return validEvents;
        }
        catch (error) {
            logger.warn('Persistent storage: replay failed', { error });
            return [];
        }
    }
    /**
     * Get storage statistics.
     */
    getStats() {
        let fileSizeBytes = 0;
        try {
            if (existsSync(this.dataFile)) {
                fileSizeBytes = statSync(this.dataFile).size;
            }
        }
        catch {
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
        };
    }
    /**
     * Clear all persisted data.
     */
    clear() {
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
        this.buffer = [];
        this.eventCount = 0;
        try {
            if (existsSync(this.dataFile)) {
                unlinkSync(this.dataFile);
            }
        }
        catch {
            // ignore
        }
    }
    /**
     * Shut down persistent storage — flush remaining events.
     */
    shutdown() {
        this.flush();
        this.initialized = false;
    }
    // ─── Internal ─────────────────────────────────────────────────────────
    scheduleFlush() {
        if (this.flushTimer)
            return;
        this.flushTimer = setTimeout(() => {
            this.flush();
            this.flushTimer = null;
        }, FLUSH_DEBOUNCE_MS);
        if (this.flushTimer) {
            this.flushTimer.unref();
        }
    }
    ensureDirectory() {
        if (!existsSync(this.directory)) {
            mkdirSync(this.directory, { recursive: true });
        }
    }
    checkAndRotate() {
        try {
            if (!existsSync(this.dataFile))
                return;
            const stats = statSync(this.dataFile);
            if (stats.size >= this.maxFileSizeBytes) {
                this.rotate();
            }
        }
        catch {
            // ignore
        }
    }
    rotate() {
        const logger = getLogger();
        try {
            if (existsSync(this.dataFile)) {
                const rotatedFile = `${this.dataFile}.${Date.now()}.bak`;
                renameSync(this.dataFile, rotatedFile);
                logger.debug('Persistent storage: file rotated', { oldFile: rotatedFile });
            }
        }
        catch (error) {
            logger.warn('Persistent storage: rotation failed', { error });
        }
        this.eventCount = 0;
    }
    rewriteFile(events) {
        try {
            const entries = events.map(event => JSON.stringify({ event, persistedAt: epochMs() })).join('\n') + '\n';
            // Atomic write: write to temp, then rename
            appendFileSync(this.tempFile, entries, { encoding: 'utf8' });
            renameSync(this.tempFile, this.dataFile);
        }
        catch (error) {
            getLogger().warn('Persistent storage: rewrite failed', { error });
            try {
                unlinkSync(this.tempFile);
            }
            catch {
                // ignore
            }
        }
    }
    resolveDefaultDirectory() {
        const appName = 'pulse-sdk';
        const platform = process.platform;
        const fallbackDir = join(tmpdir(), appName, 'events');
        if (platform === 'win32') {
            const localAppData = process.env.LOCALAPPDATA;
            if (localAppData) {
                return join(localAppData, appName, 'events');
            }
            return fallbackDir;
        }
        if (platform === 'darwin') {
            const home = process.env.HOME;
            if (home) {
                return join(home, 'Library', 'Caches', appName, 'events');
            }
            return fallbackDir;
        }
        const xdgCache = process.env.XDG_CACHE_HOME;
        const home = process.env.HOME;
        if (xdgCache) {
            return join(xdgCache, appName, 'events');
        }
        if (home) {
            return join(home, '.cache', appName, 'events');
        }
        return fallbackDir;
    }
}
export const persistentStorage = new PersistentStorage();
export { PersistentStorage };
//# sourceMappingURL=persistent-storage.js.map