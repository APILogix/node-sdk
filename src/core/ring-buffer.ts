/**
 * A fixed-capacity circular buffer with O(1) push and automatic eviction.
 * Used for breadcrumbs, recent events — any bounded-memory FIFO.
 *
 * Thread-safe for single-threaded Node.js event loop (no locks needed).
 * Does NOT block — oldest entries are silently evicted when full.
 */
export class RingBuffer<T> {
  private readonly buffer: Array<T | undefined>
  private readonly capacity: number
  private head = 0
  private count = 0

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(`RingBuffer capacity must be a positive integer, got ${capacity}`)
    }
    this.capacity = capacity
    this.buffer = new Array<T | undefined>(capacity).fill(undefined)
  }

  /** Push an item. If at capacity, the oldest item is evicted. */
  push(item: T): void {
    const index = (this.head + this.count) % this.capacity

    if (this.count === this.capacity) {
      // Buffer is full — overwrite oldest and advance head
      this.buffer[this.head] = item
      this.head = (this.head + 1) % this.capacity
    } else {
      this.buffer[index] = item
      this.count += 1
    }
  }

  /** Returns all items in insertion order (oldest first). */
  toArray(): readonly T[] {
    const result: T[] = []
    for (let i = 0; i < this.count; i++) {
      const index = (this.head + i) % this.capacity
      result.push(this.buffer[index] as T)
    }
    return result
  }

  /** Number of items currently in the buffer. */
  get size(): number {
    return this.count
  }

  /** Maximum capacity of the buffer. */
  get maxSize(): number {
    return this.capacity
  }

  /** Clear all items from the buffer. */
  clear(): void {
    this.buffer.fill(undefined)
    this.head = 0
    this.count = 0
  }

  /** Returns the most recently pushed item, or undefined if empty. */
  peek(): T | undefined {
    if (this.count === 0) return undefined
    const index = (this.head + this.count - 1) % this.capacity
    return this.buffer[index]
  }
}
