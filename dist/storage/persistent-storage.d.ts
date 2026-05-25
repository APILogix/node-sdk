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
import type { Event } from '../types/event.js';
interface PersistentStorageOptions {
    /** Directory to store persisted events. Defaults to OS temp dir. */
    directory?: string;
    /** API key hash for unique file naming. */
    apiKeyHash?: string;
    /** Maximum file size before rotation. Default: 10MB. */
    maxFileSizeBytes?: number;
    /** Maximum events to persist. Default: 10000. */
    maxEvents?: number;
    /** Event TTL in milliseconds. Default: 24 hours. */
    eventTtlMs?: number;
    /**
     * Per file-operation timeout in milliseconds. Default: 5000.
     * Protects against frozen filesystems (NFS hangs, full disks, etc.) that
     * would otherwise block the shutdown drain indefinitely.
     */
    ioTimeoutMs?: number;
}
declare class PersistentStorage {
    private directory;
    private dataFile;
    private tempFile;
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
    private writeChain;
    configure(options?: PersistentStorageOptions): void;
    init(): Promise<Event[]>;
    /**
     * Queue an event for persistence. Events are batched and flushed periodically.
     *
     * Callers can invoke this freely from any code path; it returns silently if
     * storage was never initialized or has already been shut down.
     */
    persist(event: Event): void;
    /**
     * Force-flush all buffered events to disk immediately.
     */
    flush(): Promise<void>;
    /**
     * Remove events that were successfully delivered.
     */
    discard(events: readonly Event[]): Promise<void>;
    /**
     * Replay persisted events from disk.
     * Returns events that are still valid (within TTL).
     */
    replay(): Promise<Event[]>;
    /**
     * Get storage statistics.
     */
    getStats(): {
        initialized: boolean;
        eventCount: number;
        bufferedEvents: number;
        totalPersisted: number;
        totalReplayed: number;
        totalExpired: number;
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
}
export declare const persistentStorage: PersistentStorage;
export { PersistentStorage };
export type { PersistentStorageOptions };
//# sourceMappingURL=persistent-storage.d.ts.map