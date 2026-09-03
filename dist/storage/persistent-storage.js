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
import { existsSync, unlinkSync, statSync } from 'fs';
import { appendFile, mkdir, readFile, rename, stat, unlink, writeFile } from 'fs/promises';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { createHash } from 'crypto';
import { getLogger } from '../utils/logger.js';
import { epochMs } from '../utils/time.js';
const DEFAULT_MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10MB
const DEFAULT_MAX_EVENTS = 10000;
const DEFAULT_EVENT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const FLUSH_DEBOUNCE_MS = 1000;
/**
 * Events JSON-stringified per event-loop turn during flush. Keeps the
 * synchronous serialization burst bounded so the host app stays responsive.
 */
const FLUSH_STRINGIFY_CHUNK_SIZE = 200;
const DEFAULT_IO_TIMEOUT_MS = 5_000; // Per file-operation timeout — protects against frozen filesystems.
class PersistentStorage {
    directory = '';
    dataFile = '';
    tempFile = '';
    maxFileSizeBytes = DEFAULT_MAX_FILE_SIZE_BYTES;
    maxEvents = DEFAULT_MAX_EVENTS;
    eventTtlMs = DEFAULT_EVENT_TTL_MS;
    ioTimeoutMs = DEFAULT_IO_TIMEOUT_MS;
    buffer = [];
    flushTimer = null;
    eventCount = 0;
    initialized = false;
    writeErrors = 0;
    totalPersisted = 0;
    totalReplayed = 0;
    totalExpired = 0;
    /** Events removed from disk after backend acknowledgement (successful send). */
    totalDiscarded = 0;
    /** Number of replay() calls completed (one per init). */
    replayCount = 0;
    /** Epoch ms of the most recent replay() completion. */
    lastReplayAt = 0;
    writeChain = Promise.resolve();
    configure(options = {}) {
        this.directory = options.directory ?? this.resolveDefaultDirectory();
        this.maxFileSizeBytes = options.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE_BYTES;
        this.maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS;
        this.eventTtlMs = options.eventTtlMs ?? DEFAULT_EVENT_TTL_MS;
        this.ioTimeoutMs = options.ioTimeoutMs ?? DEFAULT_IO_TIMEOUT_MS;
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
            await this.ensureDirectory();
        }
        catch (error) {
            logger.warn('Persistent storage: failed to create directory, disabling persistence', {
                directory: this.directory,
                error,
            });
            return [];
        }
        const replayed = await this.replay();
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
     *
     * Callers can invoke this freely from any code path; it returns silently if
     * storage was never initialized or has already been shut down.
     */
    persist(event) {
        if (!this.initialized)
            return;
        this.buffer.push(event);
        this.eventCount++;
        if (this.eventCount >= this.maxEvents) {
            void this.rotate();
        }
        this.scheduleFlush();
    }
    /**
     * Whether persistent storage has been initialized and has not been shut
     * down. Callers (typically the transport layer) check this before
     * persisting on send failure so they can degrade gracefully when
     * persistence is unavailable (e.g., the SDK is being shut down).
     */
    get isInitialized() {
        return this.initialized;
    }
    /**
     * Persist a whole batch of events in one call.
     *
     * Equivalent to calling `persist(event)` for every event but avoids N
     * separate buffer pushes plus N separate `scheduleFlush` calls. Used by
     * the transport layer when an entire batch fails to send and must be
     * durably retained for replay.
     */
    persistBatch(events) {
        if (!this.initialized || events.length === 0)
            return;
        for (const event of events) {
            this.buffer.push(event);
            this.eventCount++;
        }
        if (this.eventCount >= this.maxEvents) {
            void this.rotate();
        }
        this.scheduleFlush();
    }
    /**
     * Force-flush all buffered events to disk immediately.
     */
    async flush() {
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
        if (this.buffer.length === 0)
            return;
        const logger = getLogger();
        const entries = [];
        // Stringify in chunks, yielding to the event loop between them — a
        // large buffer serialized in one synchronous loop would block the
        // host application's event loop for the entire duration.
        let processed = 0;
        for (const event of this.buffer) {
            const entry = {
                event,
                persistedAt: epochMs(),
            };
            entries.push(JSON.stringify(entry));
            processed++;
            if (processed % FLUSH_STRINGIFY_CHUNK_SIZE === 0) {
                await new Promise(resolve => setImmediate(resolve));
            }
        }
        try {
            await this.checkAndRotate();
            const content = entries.join('\n') + '\n';
            await this.enqueueWrite(() => appendFile(this.dataFile, content, { encoding: 'utf8' }));
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
    async discard(events) {
        if (events.length === 0)
            return;
        const deliveredIds = new Set(events
            .map(event => event.eventId)
            .filter((eventId) => typeof eventId === 'string' && eventId.length > 0));
        if (deliveredIds.size === 0)
            return;
        const beforeBuffer = this.buffer.length;
        this.buffer = this.buffer.filter(event => !deliveredIds.has(event.eventId ?? ''));
        const removedFromBuffer = beforeBuffer - this.buffer.length;
        if (!existsSync(this.dataFile)) {
            // Nothing on disk — discard count is purely the buffer trim.
            this.totalDiscarded += removedFromBuffer;
            return;
        }
        try {
            const content = await withIoTimeout(readFile(this.dataFile, { encoding: 'utf8' }), this.ioTimeoutMs, 'persistent-storage discard read');
            const retainedEntries = [];
            let removedFromDisk = 0;
            for (const line of content.split('\n')) {
                if (line.trim().length === 0)
                    continue;
                try {
                    const entry = JSON.parse(line);
                    if (deliveredIds.has(entry.event.eventId ?? '')) {
                        removedFromDisk++;
                    }
                    else {
                        retainedEntries.push(entry);
                    }
                }
                catch {
                    // Drop malformed lines while compacting acknowledged events.
                }
            }
            await this.rewriteEntries(retainedEntries);
            this.eventCount = retainedEntries.length + this.buffer.length;
            this.totalDiscarded += removedFromBuffer + removedFromDisk;
        }
        catch (error) {
            getLogger().warn('Persistent storage: discard failed', { error });
        }
    }
    /**
     * Replay persisted events from disk.
     * Returns events that are still valid (within TTL).
     */
    async replay() {
        const logger = getLogger();
        if (!existsSync(this.dataFile)) {
            return [];
        }
        try {
            const content = await withIoTimeout(readFile(this.dataFile, { encoding: 'utf8' }), this.ioTimeoutMs, 'persistent-storage replay read');
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
                await this.rewriteFile(validEvents);
            }
            this.replayCount++;
            this.lastReplayAt = epochMs();
            logger.info('Persistent storage: replay complete', {
                totalLines: lines.length,
                validEvents: validEvents.length,
                expiredEvents: this.totalExpired,
                replayCount: this.replayCount,
                note: validEvents.length > 0
                    ? 'Replayed events were undelivered at last shutdown — backend MUST dedupe by eventId'
                    : 'No undelivered events to replay',
            });
            return validEvents;
        }
        catch (error) {
            logger.warn('Persistent storage: replay failed', { error });
            return [];
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
            totalDiscarded: this.totalDiscarded,
            replayCount: this.replayCount,
            lastReplayAt: this.lastReplayAt,
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
    async shutdown() {
        // Reject new persist() calls immediately so concurrent producers can't
        // push into a buffer that's about to be drained.
        this.initialized = false;
        // Cancel any pending debounced flush — we'll perform a final flush below.
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
        try {
            await this.flush();
        }
        catch (err) {
            getLogger().warn('Persistent storage: final flush failed during shutdown', { error: err });
        }
        // Drain the serial write chain so any rename/append in flight completes.
        // Catching here ensures shutdown never throws — the upstream lifecycle
        // step error handler will record any failure for observability.
        try {
            await this.writeChain;
        }
        catch (err) {
            getLogger().warn('Persistent storage: write chain drain failed during shutdown', { error: err });
        }
        // Re-arm the chain to a fresh resolved promise so a subsequent init()
        // does not chain new writes onto an old (possibly rejected) chain.
        this.writeChain = Promise.resolve();
    }
    // ─── Internal ─────────────────────────────────────────────────────────
    scheduleFlush() {
        if (this.flushTimer)
            return;
        this.flushTimer = setTimeout(() => {
            this.flush().catch(error => {
                getLogger().warn('Persistent storage: scheduled flush failed', { error });
            });
            this.flushTimer = null;
        }, FLUSH_DEBOUNCE_MS);
        if (this.flushTimer) {
            this.flushTimer.unref();
        }
    }
    async ensureDirectory() {
        if (!existsSync(this.directory)) {
            await mkdir(this.directory, { recursive: true });
        }
    }
    async checkAndRotate() {
        try {
            // Async stat — the previous existsSync + statSync pair issued two
            // blocking syscalls on every flush. `stat` throws ENOENT when the
            // file doesn't exist yet, which the catch treats as "nothing to
            // rotate".
            const stats = await stat(this.dataFile);
            if (stats.size >= this.maxFileSizeBytes) {
                await this.rotate();
            }
        }
        catch {
            // File missing or unreadable — nothing to rotate.
        }
    }
    async rotate() {
        const logger = getLogger();
        try {
            if (existsSync(this.dataFile)) {
                const rotatedFile = `${this.dataFile}.${Date.now()}.bak`;
                await rename(this.dataFile, rotatedFile);
                logger.debug('Persistent storage: file rotated', { oldFile: rotatedFile });
            }
        }
        catch (error) {
            logger.warn('Persistent storage: rotation failed', { error });
        }
        this.eventCount = 0;
    }
    async rewriteFile(events) {
        try {
            await this.rewriteEntries(events.map(event => ({ event, persistedAt: epochMs() })));
        }
        catch (error) {
            getLogger().warn('Persistent storage: rewrite failed', { error });
            try {
                void unlink(this.tempFile);
            }
            catch {
                // ignore
            }
        }
    }
    async rewriteEntries(entriesToWrite) {
        const content = entriesToWrite.length > 0
            ? entriesToWrite.map(entry => JSON.stringify(entry)).join('\n') + '\n'
            : '';
        await this.enqueueWrite(async () => {
            if (content.length === 0) {
                await unlink(this.dataFile).catch(error => {
                    if (error.code !== 'ENOENT')
                        throw error;
                });
                return;
            }
            await writeFile(this.tempFile, content, { encoding: 'utf8' });
            await rename(this.tempFile, this.dataFile);
        });
    }
    enqueueWrite(operation) {
        // Wrap the operation with a per-op timeout so a hung filesystem (NFS,
        // full disk, frozen volume) cannot stall the shutdown drain indefinitely.
        const timed = () => withIoTimeout(operation(), this.ioTimeoutMs, 'persistent-storage write');
        this.writeChain = this.writeChain.then(timed, timed);
        return this.writeChain;
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
/**
 * Race a file-system operation against a timeout. Used to protect every
 * write against frozen volumes (NFS, full disks, disconnected mounts).
 * Rejects with a descriptive error so the caller can record the failure
 * and continue without blocking the shutdown drain.
 */
function withIoTimeout(promise, timeoutMs, label) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
        timer.unref?.();
    });
    return Promise.race([promise, timeout]).finally(() => {
        if (timer)
            clearTimeout(timer);
    });
}
