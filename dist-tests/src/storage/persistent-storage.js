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
import { existsSync, unlinkSync, statSync, readdirSync, createReadStream, createWriteStream, appendFileSync } from 'fs';
import { appendFile, copyFile, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'fs/promises';
import { createInterface } from 'readline';
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
const MAX_BACKUP_FILES = 3;
class PersistentStorage {
    directoryPath = '';
    filePrefix = 'lynktrace-events';
    dataFile = '';
    enabled = true;
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
    persistedIds = new Set();
    customDirectoryConfigured = false;
    /** Tracks the whole flush operation, including chunked serialization before disk enqueue. */
    flushChain = Promise.resolve();
    configure(options = {}) {
        if (options.enabled !== undefined) {
            this.enabled = options.enabled;
        }
        if (options.directory) {
            this.directoryPath = options.directory;
            this.customDirectoryConfigured = true;
        }
        else {
            this.directoryPath = this.resolveDefaultDirectory();
            this.customDirectoryConfigured = false;
        }
        this.maxFileSizeBytes = options.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE_BYTES;
        this.maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS;
        this.eventTtlMs = options.eventTtlMs ?? DEFAULT_EVENT_TTL_MS;
        this.ioTimeoutMs = options.ioTimeoutMs ?? DEFAULT_IO_TIMEOUT_MS;
        const suffix = options.apiKeyHash ? `-${options.apiKeyHash.slice(0, 8)}` : '';
        this.filePrefix = `lynktrace-events${suffix}`;
        this.dataFile = join(this.directoryPath, `${this.filePrefix}-${process.pid}.ndjson`);
    }
    createTempFilePath() {
        const randomSuffix = Math.random().toString(36).slice(2);
        return join(this.directoryPath, `.${this.filePrefix}-${process.pid}-${Date.now()}-${randomSuffix}.tmp`);
    }
    async init() {
        if (this.initialized)
            return [];
        if (!this.enabled) {
            this.initialized = false;
            return [];
        }
        const logger = getLogger();
        try {
            await withIoTimeout(this.ensureDirectory(), this.ioTimeoutMs, 'persistent-storage init');
        }
        catch (primaryError) {
            const tmpFallbackDir = join(tmpdir(), 'telemetry-sdk', 'events');
            if (!this.customDirectoryConfigured && this.directoryPath !== tmpFallbackDir) {
                try {
                    this.directoryPath = tmpFallbackDir;
                    this.dataFile = join(this.directoryPath, `${this.filePrefix}-${process.pid}.ndjson`);
                    await withIoTimeout(this.ensureDirectory(), this.ioTimeoutMs, 'persistent-storage tmp-fallback');
                }
                catch (fallbackError) {
                    this.initialized = false;
                    logger.debug('Persistent storage: primary and /tmp directories are read-only; running in-memory only', {
                        code: fallbackError?.code,
                    });
                    return [];
                }
            }
            else {
                this.initialized = false;
                logger.debug('Persistent storage: filesystem is read-only; running in-memory only', {
                    directory: this.directoryPath,
                    code: primaryError?.code,
                });
                return [];
            }
        }
        this.initialized = true;
        const replayController = new AbortController();
        const replayTimeoutMs = this.ioTimeoutMs * 2;
        const replayed = await withIoTimeout(this.replay(Date.now() + replayTimeoutMs, replayController.signal), replayTimeoutMs, 'persistent-storage replay', () => replayController.abort()).catch(() => []);
        this.totalReplayed = replayed.length;
        logger.info('Persistent storage initialized', {
            directory: this.directoryPath,
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
     * storage was never initialized, is disabled, or has already been shut down.
     */
    persist(event) {
        if (!this.initialized || !this.enabled)
            return;
        if (this.buffer.length >= this.maxEvents) {
            this.buffer.shift();
        }
        this.buffer.push(event);
        if (this.buffer.length >= FLUSH_STRINGIFY_CHUNK_SIZE) {
            void this.flush();
        }
        else {
            this.scheduleFlush();
        }
    }
    /**
     * Whether persistent storage has been initialized and has not been shut
     * down or disabled. Callers (typically the transport layer) check this before
     * persisting on send failure so they can degrade gracefully when
     * persistence is unavailable (e.g., the SDK is being shut down or serverless).
     */
    get isInitialized() {
        return this.initialized && this.enabled;
    }
    /** The configured or resolved directory path where events are persisted. */
    get directory() {
        return this.directoryPath;
    }
    /** The path to the active events NDJSON data file. */
    get dataFilePath() {
        return this.dataFile;
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
        if (!this.initialized || !this.enabled || events.length === 0)
            return;
        const toAdd = events.length > this.maxEvents ? events.slice(-this.maxEvents) : events;
        const overflow = (this.buffer.length + toAdd.length) - this.maxEvents;
        if (overflow > 0) {
            this.buffer.splice(0, overflow);
        }
        for (const event of toAdd) {
            this.buffer.push(event);
        }
        if (this.buffer.length >= FLUSH_STRINGIFY_CHUNK_SIZE) {
            void this.flush();
        }
        else {
            this.scheduleFlush();
        }
    }
    /**
     * Synchronous flush for crash paths (SIGKILL, uncaughtException).
     * Appends all buffered and extra events directly to disk using appendFileSync.
     */
    flushSync(extraEvents) {
        if (!this.initialized || !this.enabled)
            return;
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
        const toFlush = [...this.buffer, ...(extraEvents ?? [])];
        this.buffer.length = 0;
        if (toFlush.length === 0)
            return;
        try {
            const entries = [];
            const now = epochMs();
            for (const event of toFlush) {
                entries.push(JSON.stringify({ event, persistedAt: now }));
            }
            const content = entries.join('\n') + '\n';
            appendFileSync(this.dataFile, content, { encoding: 'utf8', mode: 0o600 });
            this.totalPersisted += toFlush.length;
            this.eventCount += toFlush.length;
            for (const event of toFlush) {
                if (event.eventId)
                    this.persistedIds.add(event.eventId);
            }
        }
        catch { }
    }
    /**
     * Force-flush all buffered events to disk immediately.
     */
    async flush() {
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
        // A flush can spend many event-loop turns stringifying a large batch
        // before it enters writeChain. Tracking only writeChain let shutdown
        // return while this pre-write work was still pending, losing the queue.
        const operation = this.flushChain.then(() => this.flushBuffer());
        this.flushChain = operation.catch(() => { });
        await operation;
    }
    async flushBuffer() {
        if (this.buffer.length === 0)
            return;
        // Atomically snapshot and drain the buffer so concurrent flush() calls
        // or newly arriving events do not duplicate or get overwritten.
        const toFlush = this.buffer;
        this.buffer = [];
        const logger = getLogger();
        const entries = [];
        // Stringify in chunks, yielding to the event loop between them — a
        // large buffer serialized in one synchronous loop would block the
        // host application's event loop for the entire duration.
        let processed = 0;
        for (const event of toFlush) {
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
            const content = entries.join('\n') + '\n';
            await this.enqueueWrite(async () => {
                if (this.eventCount + toFlush.length > this.maxEvents) {
                    await this.rotate();
                }
                else {
                    await this.checkAndRotate();
                }
                await appendFile(this.dataFile, content, { encoding: 'utf8', mode: 0o600 });
                this.eventCount += toFlush.length;
            });
            this.totalPersisted += toFlush.length;
            for (const event of toFlush) {
                if (event.eventId) {
                    this.persistedIds.add(event.eventId);
                }
            }
            if (this.persistedIds.size > this.maxEvents * 2) {
                const excess = this.persistedIds.size - this.maxEvents * 2;
                let evicted = 0;
                for (const id of this.persistedIds.keys()) {
                    this.persistedIds.delete(id);
                    evicted++;
                    if (evicted >= excess)
                        break;
                }
            }
        }
        catch (error) {
            this.writeErrors++;
            const code = error?.code;
            if (code === 'EROFS' || code === 'ENOSPC' || code === 'EACCES' || code === 'EPERM' || code === 'EISDIR' || this.writeErrors >= 10) {
                logger.warn('Persistent storage disabled due to non-recoverable write error; releasing buffer', {
                    code,
                    writeErrors: this.writeErrors,
                });
                this.initialized = false;
                this.buffer.length = 0;
                this.persistedIds.clear();
                return;
            }
            const available = Math.max(0, this.maxEvents - this.buffer.length);
            if (available > 0) {
                this.buffer.unshift(...toFlush.slice(toFlush.length - available));
            }
            logger.warn('Persistent storage: write failed', {
                error,
                writeErrors: this.writeErrors,
                bufferedEvents: this.buffer.length,
            });
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
        // In normal operation, batches are delivered without ever being written
        // to disk. Replay and failed sends register IDs here so acknowledged rows
        // can be removed from every rotated or orphaned queue segment.
        let hasPersistedDelivered = false;
        for (const id of deliveredIds) {
            if (this.persistedIds.has(id)) {
                hasPersistedDelivered = true;
                break;
            }
        }
        if (!hasPersistedDelivered) {
            // Nothing on disk or delivered events were not persisted — discard count is purely the buffer trim.
            this.totalDiscarded += removedFromBuffer;
            return;
        }
        try {
            await this.enqueueWrite(async () => {
                const files = await this.listReplayableFiles();
                let removedFromDisk = 0;
                let activeFileRetained = null;
                for (const filePath of files) {
                    if (!existsSync(filePath))
                        continue;
                    const tempFile = this.createTempFilePath();
                    let retainedCount = 0;
                    let removedInFile = 0;
                    try {
                        const readStream = createReadStream(filePath, { encoding: 'utf8', highWaterMark: 64 * 1024 });
                        const writeStream = createWriteStream(tempFile, { encoding: 'utf8', mode: 0o600 });
                        const rl = createInterface({ input: readStream, crlfDelay: Infinity });
                        let lineCounter = 0;
                        for await (const line of rl) {
                            const trimmed = line.trim();
                            if (trimmed.length === 0)
                                continue;
                            let eventId;
                            try {
                                const entry = JSON.parse(trimmed);
                                eventId = entry.event?.eventId;
                            }
                            catch {
                                // Drop malformed rows while compacting acknowledged segments.
                                continue;
                            }
                            if (eventId && deliveredIds.has(eventId)) {
                                removedInFile++;
                            }
                            else {
                                writeStream.write(trimmed + '\n');
                                retainedCount++;
                            }
                            if (++lineCounter % 250 === 0)
                                await new Promise(resolve => setImmediate(resolve));
                        }
                        await new Promise((resolve, reject) => {
                            writeStream.once('error', reject);
                            writeStream.end(resolve);
                        });
                        if (removedInFile > 0) {
                            if (retainedCount === 0) {
                                await unlink(filePath).catch(() => { });
                                await unlink(tempFile).catch(() => { });
                            }
                            else {
                                await safeAtomicRename(tempFile, filePath);
                            }
                            removedFromDisk += removedInFile;
                        }
                        else {
                            await unlink(tempFile).catch(() => { });
                        }
                        if (filePath === this.dataFile)
                            activeFileRetained = retainedCount;
                    }
                    catch (streamErr) {
                        await unlink(tempFile).catch(() => { });
                        throw streamErr;
                    }
                }
                for (const id of deliveredIds)
                    this.persistedIds.delete(id);
                if (activeFileRetained !== null)
                    this.eventCount = activeFileRetained + this.buffer.length;
                else if (!existsSync(this.dataFile))
                    this.eventCount = this.buffer.length;
                this.totalDiscarded += removedFromBuffer + removedFromDisk;
                if (this.persistedIds.size === 0) {
                    // Keep unrelated backlog IDs already represented in the queue by
                    // loading the active file lazily on the next replay.
                    this.persistedIds.clear();
                }
            });
        }
        catch (error) {
            getLogger().warn('Persistent storage: discard failed', { error });
        }
    }
    /** List queue segments owned by this key, excluding live sibling writers. */
    async listReplayableFiles() {
        const names = await readdir(this.directoryPath).catch(() => []);
        const legacyPrefix = `pulse-events${this.filePrefix.startsWith('lynktrace-events') ? this.filePrefix.slice('lynktrace-events'.length) : ''}`;
        const filePattern = new RegExp(`^(?:${this.filePrefix}|${legacyPrefix})(?:-(\\d+))?\\.ndjson(?:\\.(\\d+)\\.bak)?$`);
        const files = [];
        for (const name of names) {
            const match = filePattern.exec(name);
            if (!match)
                continue;
            const pidText = match[1];
            if (pidText !== undefined) {
                const pid = Number.parseInt(pidText, 10);
                if (pid !== process.pid && isPidAlive(pid))
                    continue;
            }
            files.push(join(this.directoryPath, name));
        }
        return files;
    }
    async restoreClaim(claimPath, originalPath) {
        if (existsSync(originalPath)) {
            const contents = await readFile(claimPath);
            await appendFile(originalPath, contents);
            await unlink(claimPath);
            return;
        }
        try {
            await safeAtomicRename(claimPath, originalPath);
        }
        catch (error) {
            if (!existsSync(originalPath))
                throw error;
            // If another writer recreated the original name, append the still-owned
            // claim before removing it. A crash during this fallback can duplicate
            // rows, which are safe because event IDs are stable and backend-deduped.
            const contents = await readFile(claimPath);
            await appendFile(originalPath, contents);
            await unlink(claimPath);
        }
    }
    async recoverOrphanedClaims(entries) {
        const legacyPrefix = `pulse-events${this.filePrefix.startsWith('lynktrace-events') ? this.filePrefix.slice('lynktrace-events'.length) : ''}`;
        const claimPattern = /^\.(.+\.ndjson(?:\.\d+\.bak)?)\.claim-(\d+)-\d+-[a-z0-9]+\.tmp$/i;
        for (const name of entries) {
            const match = claimPattern.exec(name);
            if (!match || !match[1] || !match[2])
                continue;
            const originalName = match[1];
            if (!originalName.startsWith(this.filePrefix) && !originalName.startsWith(legacyPrefix))
                continue;
            const ownerPid = Number.parseInt(match[2], 10);
            if (ownerPid === process.pid || isPidAlive(ownerPid))
                continue;
            const claimPath = join(this.directoryPath, name);
            const originalPath = join(this.directoryPath, originalName);
            try {
                await this.restoreClaim(claimPath, originalPath);
            }
            catch {
                // Leave an unrecoverable claim in place so a later startup can retry.
            }
        }
    }
    /**
     * Replay persisted events from disk.
     * Returns events that are still valid (within TTL).
     *
     * Multi-process / cluster safe:
     * 1. Inspects the directory for files belonging to this prefix (or legacy pulse-events).
     * 2. Replays legacy file (pulse-events.ndjson / pulse-events-<hash>.ndjson) if present.
     * 3. Replays files from dead processes (PIDs that are no longer alive).
     * 4. Exclusively claims candidate files via atomic rename before reading to
     *    prevent multiple workers from racing or duplicating replay batches.
     */
    async replay(deadlineMs, signal) {
        const logger = getLogger();
        const now = epochMs();
        const validEvents = [];
        let totalLines = 0;
        if (!existsSync(this.directoryPath)) {
            return [];
        }
        try {
            let dirEntries = await readdir(this.directoryPath).catch(() => []);
            await this.recoverOrphanedClaims(dirEntries);
            dirEntries = await readdir(this.directoryPath).catch(() => []);
            const prefix = this.filePrefix;
            const legacyPrefix = `pulse-events${this.filePrefix.startsWith('lynktrace-events') ? this.filePrefix.slice('lynktrace-events'.length) : ''}`;
            const candidateList = [];
            const filePattern = new RegExp(`^(?:${prefix}|${legacyPrefix})(?:-(\\d+))?\\.ndjson(?:\\.(\\d+)\\.bak)?$`);
            for (const entry of dirEntries) {
                if (entry.startsWith('.'))
                    continue;
                const match = entry.match(filePattern);
                if (!match)
                    continue;
                const pidStr = match[1];
                const bakTimestampStr = match[2];
                if (pidStr !== undefined) {
                    const filePid = parseInt(pidStr, 10);
                    if (filePid !== process.pid && isPidAlive(filePid)) {
                        // Belongs to an active sibling process; do not claim
                        continue;
                    }
                }
                // Chronological order: older rotated backups first, active (.ndjson) last
                const orderTimestamp = bakTimestampStr !== undefined ? parseInt(bakTimestampStr, 10) : Number.MAX_SAFE_INTEGER;
                candidateList.push({ name: entry, orderTimestamp });
            }
            // Sort candidate files chronologically so older rotated segments are replayed before active files
            candidateList.sort((a, b) => a.orderTimestamp - b.orderTimestamp);
            const candidateFiles = candidateList.map(c => c.name);
            for (const fileName of candidateFiles) {
                if (signal?.aborted || (deadlineMs !== undefined && Date.now() >= deadlineMs)) {
                    logger.debug('Persistent storage: replay deadline reached, remaining files deferred to next startup');
                    break;
                }
                const fullPath = join(this.directoryPath, fileName);
                const randomToken = Math.random().toString(36).slice(2);
                const claimPath = join(this.directoryPath, `.${fileName}.claim-${process.pid}-${Date.now()}-${randomToken}.tmp`);
                let claimed = false;
                try {
                    await rename(fullPath, claimPath);
                    claimed = true;
                }
                catch {
                    // Another worker claimed it or file missing/locked
                    continue;
                }
                if (!claimed)
                    continue;
                let completedFile = false;
                const firstEventIndex = validEvents.length;
                try {
                    const readStream = createReadStream(claimPath, { encoding: 'utf8', highWaterMark: 64 * 1024 });
                    const rl = createInterface({ input: readStream, crlfDelay: Infinity });
                    let lineCounter = 0;
                    for await (const line of rl) {
                        if (signal?.aborted || (deadlineMs !== undefined && Date.now() >= deadlineMs)) {
                            rl.close();
                            readStream.destroy();
                            throw new Error('Persistent storage replay aborted at deadline');
                        }
                        const trimmed = line.trim();
                        if (trimmed.length === 0)
                            continue;
                        totalLines++;
                        try {
                            const entry = JSON.parse(trimmed);
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
                        lineCounter++;
                        if (lineCounter % 250 === 0) {
                            await new Promise(resolve => setImmediate(resolve));
                        }
                    }
                    completedFile = true;
                }
                finally {
                    if (completedFile) {
                        if (validEvents.length > firstEventIndex) {
                            // Keep the durable source until the backend acknowledges these
                            // event IDs. This makes replay at-least-once across queue
                            // saturation, shutdown, and process termination.
                            await this.restoreClaim(claimPath, fullPath);
                            for (const event of validEvents.slice(firstEventIndex)) {
                                if (event.eventId)
                                    this.persistedIds.add(event.eventId);
                            }
                        }
                        else {
                            await unlink(claimPath).catch(() => { });
                        }
                    }
                    else {
                        await this.restoreClaim(claimPath, fullPath).catch(() => { });
                    }
                }
            }
            this.replayCount++;
            this.lastReplayAt = epochMs();
            logger.info('Persistent storage: replay complete', {
                totalLines,
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
        this.persistedIds.clear();
        try {
            if (existsSync(this.dataFile)) {
                unlinkSync(this.dataFile);
            }
            if (existsSync(this.directoryPath)) {
                const files = readdirSync(this.directoryPath);
                for (const f of files) {
                    if (f.startsWith(this.filePrefix) || f.startsWith(`.${this.filePrefix}`)) {
                        try {
                            unlinkSync(join(this.directoryPath, f));
                        }
                        catch { }
                    }
                }
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
            await this.flushChain;
            await this.writeChain;
        }
        catch (err) {
            getLogger().warn('Persistent storage: write chain drain failed during shutdown', { error: err });
        }
        // Re-arm the chain to a fresh resolved promise so a subsequent init()
        // does not chain new writes onto an old (possibly rejected) chain.
        this.writeChain = Promise.resolve();
        this.flushChain = Promise.resolve();
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
        if (!existsSync(this.directoryPath)) {
            await mkdir(this.directoryPath, { recursive: true, mode: 0o700 });
        }
        // Writability probe: verifies the directory is actually writable (not EROFS / EACCES)
        const probeFile = join(this.directoryPath, `.lynktrace-probe-${process.pid}-${Date.now()}.tmp`);
        await writeFile(probeFile, '', { encoding: 'utf8' });
        await unlink(probeFile).catch(() => { });
    }
    async checkAndRotate() {
        try {
            if (this.eventCount >= this.maxEvents) {
                await this.rotate();
                return;
            }
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
                await safeAtomicRename(this.dataFile, rotatedFile);
                logger.debug('Persistent storage: file rotated', { oldFile: rotatedFile });
                const entries = await readdir(this.directoryPath).catch(() => []);
                const bakPattern = new RegExp(`^${this.filePrefix}(?:-\\d+)?\\.ndjson\\.(\\d+)\\.bak$`);
                const bakFiles = [];
                for (const f of entries) {
                    const m = f.match(bakPattern);
                    if (m && m[1]) {
                        bakFiles.push({ name: f, ts: parseInt(m[1], 10) });
                    }
                }
                bakFiles.sort((a, b) => a.ts - b.ts);
                while (bakFiles.length > MAX_BACKUP_FILES) {
                    const oldest = bakFiles.shift();
                    await unlink(join(this.directoryPath, oldest.name)).catch(() => { });
                }
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
            const tempFile = this.createTempFilePath();
            try {
                await writeFile(tempFile, content, { encoding: 'utf8', mode: 0o600 });
                await safeAtomicRename(tempFile, this.dataFile);
            }
            finally {
                await unlink(tempFile).catch(() => { });
            }
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
        const appName = 'telemetry-sdk';
        const platform = process.platform;
        const fallbackDir = join(tmpdir(), appName, 'events');
        // In serverless environments (AWS Lambda, GCP Cloud Functions, Azure Functions, Vercel),
        // /tmp is the only writable directory. HOME (/var/task, /root, /workspace) is read-only.
        if (this.isServerlessEnvironment()) {
            return fallbackDir;
        }
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
        if (home && home !== '/var/task' && home !== '/root') {
            return join(home, '.cache', appName, 'events');
        }
        return fallbackDir;
    }
    isServerlessEnvironment() {
        return Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME ||
            process.env.K_SERVICE ||
            process.env.FUNCTIONS_WORKER_RUNTIME ||
            process.env.VERCEL ||
            process.env.NOW_REGION);
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
function withIoTimeout(promise, timeoutMs, label, onTimeout) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
            onTimeout?.();
            reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        // The caller is awaiting this bounded I/O operation. Keep its deadline
        // referenced so shutdown cannot be abandoned while a filesystem promise
        // remains pending without any other active handles.
    });
    return Promise.race([promise, timeout]).finally(() => {
        if (timer)
            clearTimeout(timer);
    });
}
/**
 * Windows-safe atomic rename with retry and fallback.
 * On Windows (NTFS), destination files locked by indexers/antivirus or brief
 * open handles throw EPERM/EBUSY. Retries with backoff and falls back to
 * copy+unlink to guarantee non-crashing compaction.
 */
async function safeAtomicRename(source, target) {
    const isWindows = process.platform === 'win32';
    const maxAttempts = isWindows ? 5 : 2;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
            await rename(source, target);
            return;
        }
        catch (err) {
            const code = err.code;
            if (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES' || code === 'EEXIST') {
                if (attempt < maxAttempts - 1) {
                    if (isWindows && (target.endsWith('.tmp') || target.includes('.claim'))) {
                        await unlink(target).catch(() => { });
                    }
                    await new Promise(r => setTimeout(r, (attempt + 1) * 10));
                    continue;
                }
                await copyFile(source, target);
                await unlink(source).catch(() => { });
                return;
            }
            throw err;
        }
    }
}
function isPidAlive(pid) {
    if (pid <= 0 || !Number.isInteger(pid))
        return false;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (err) {
        return err.code === 'EPERM';
    }
}
