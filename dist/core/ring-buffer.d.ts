/**
 * A fixed-capacity circular buffer with O(1) push and automatic eviction.
 * Used for breadcrumbs, recent events — any bounded-memory FIFO.
 *
 * Thread-safe for single-threaded Node.js event loop (no locks needed).
 * Does NOT block — oldest entries are silently evicted when full.
 */
export declare class RingBuffer<T> {
    private readonly buffer;
    private readonly capacity;
    private head;
    private count;
    constructor(capacity: number);
    /** Push an item. If at capacity, the oldest item is evicted. */
    push(item: T): void;
    /** Returns all items in insertion order (oldest first). */
    toArray(): readonly T[];
    /** Number of items currently in the buffer. */
    get size(): number;
    /** Maximum capacity of the buffer. */
    get maxSize(): number;
    /** Clear all items from the buffer. */
    clear(): void;
    /** Returns the most recently pushed item, or undefined if empty. */
    peek(): T | undefined;
}
//# sourceMappingURL=ring-buffer.d.ts.map