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
import type { Event } from '../types/event.js';
interface PersistentStorageOptions {
    /** Directory to store persisted events. Defaults to OS temp dir. */
    directory?: string | undefined;
    /** Whether persistence is enabled. When false, disk operations are completely bypassed. Default: true. */
    enabled?: boolean | undefined;
    /** API key hash for unique file naming. */
    apiKeyHash?: string | undefined;
    /** Maximum file size before rotation. Default: 10MB. */
    maxFileSizeBytes?: number | undefined;
    /** Maximum events to persist. Default: 10000. */
    maxEvents?: number | undefined;
    /** Event TTL in milliseconds. Default: 24 hours. */
    eventTtlMs?: number | undefined;
    /**
     * Per file-operation timeout in milliseconds. Default: 5000.
     * Protects against frozen filesystems (NFS hangs, full disks, etc.) that
     * would otherwise block the shutdown drain indefinitely.
     */
    ioTimeoutMs?: number | undefined;
}
declare class PersistentStorage {
    private directoryPath;
    private filePrefix;
    private dataFile;
    private enabled;
    private maxFileSizeBytes;
    private maxEvents;
    private eventTtlMs;
    private ioTimeoutMs;
    private buffer;
    private flushTimer;
    private eventCount;
    private initialized;
    private writeErrors;
    private totalPersisted;
    private totalReplayed;
    private totalExpired;
    /** Events removed from disk after backend acknowledgement (successful send). */
    private totalDiscarded;
    /** Number of replay() calls completed (one per init). */
    private replayCount;
    /** Epoch ms of the most recent replay() completion. */
    private lastReplayAt;
    private writeChain;
    private persistedIds;
    private customDirectoryConfigured;
    configure(options?: PersistentStorageOptions): void;
    private createTempFilePath;
    init(): Promise<Event[]>;
    /**
     * Queue an event for persistence. Events are batched and flushed periodically.
     *
     * Callers can invoke this freely from any code path; it returns silently if
     * storage was never initialized, is disabled, or has already been shut down.
     */
    persist(event: Event): void;
    /**
     * Whether persistent storage has been initialized and has not been shut
     * down or disabled. Callers (typically the transport layer) check this before
     * persisting on send failure so they can degrade gracefully when
     * persistence is unavailable (e.g., the SDK is being shut down or serverless).
     */
    get isInitialized(): boolean;
    /** The configured or resolved directory path where events are persisted. */
    get directory(): string;
    /** The path to the active events NDJSON data file. */
    get dataFilePath(): string;
    /**
     * Persist a whole batch of events in one call.
     *
     * Equivalent to calling `persist(event)` for every event but avoids N
     * separate buffer pushes plus N separate `scheduleFlush` calls. Used by
     * the transport layer when an entire batch fails to send and must be
     * durably retained for replay.
     */
    persistBatch(events: readonly Event[]): void;
    /**
     * Force-flush all buffered events to disk immediately.
     */
    flush(): Promise<void>;
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
    discard(events: readonly Event[]): Promise<void>;
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
    replay(deadlineMs?: number): Promise<Event[]>;
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
        initialized: boolean;
        eventCount: number;
        bufferedEvents: number;
        totalPersisted: number;
        totalReplayed: number;
        totalExpired: number;
        totalDiscarded: number;
        replayCount: number;
        lastReplayAt: number;
        writeErrors: number;
        fileSizeBytes: number;
    };
    /**
     * Clear all persisted data.
     */
    clear(): void;
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
    shutdown(): Promise<void>;
    private scheduleFlush;
    private ensureDirectory;
    private checkAndRotate;
    private rotate;
    private rewriteFile;
    private rewriteEntries;
    private enqueueWrite;
    private resolveDefaultDirectory;
    private isServerlessEnvironment;
}
export declare const persistentStorage: PersistentStorage;
export { PersistentStorage };
export type { PersistentStorageOptions };
