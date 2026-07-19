import type { SDKEvent } from '../types/event.js'
import type { EnterpriseRoute } from './route-registry.js'

export type QueuePriority = 'high' | 'normal' | 'low'
export type QueueDropReason = 'queue_full' | 'event_too_large' | 'serialization_failed' | 'transport_disabled' | 'route_unavailable' | 'route_unconfigured'
export type QueueOverflowStrategy = 'drop_oldest' | 'drop_newest'

export interface QueueDropInfo {
  readonly route: EnterpriseRoute
  readonly reason: QueueDropReason
  readonly count: number
  readonly eventType?: string | undefined
}

export interface TransportEventQueueOptions {
  readonly route: EnterpriseRoute
  readonly maxSize: number
  readonly priority: QueuePriority
  readonly onDrop?: (info: QueueDropInfo) => void
  /**
   * What to do when the queue is full. Driven by remote config
   * (`transport.queue.overflowStrategy`). Defaults to 'drop_newest'
   * (reject the incoming event) to preserve pre-existing behaviour.
   */
  readonly overflowStrategy?: QueueOverflowStrategy
}

/**
 * Bounded event queue backed by a ring buffer.
 *
 * Every hot-path operation is O(1): `enqueue` writes at the tail,
 * `drain` advances the head index, and `drop_oldest` eviction just moves
 * the head forward. The previous array-based implementation used
 * `Array.shift()` for drop_oldest, which is O(capacity) per evicted event
 * — under sustained overflow (e.g. a backlogged traces route dropping
 * tens of thousands of spans) that quadratic cost froze the event loop
 * and delayed unrelated routes sharing the process.
 */
export class TransportEventQueue {
  readonly route: EnterpriseRoute
  readonly maxSize: number
  readonly priority: QueuePriority
  private readonly overflowStrategy: QueueOverflowStrategy
  private buffer: (SDKEvent | undefined)[]
  private readonly capacity: number
  private head = 0
  private count = 0
  private readonly onDrop: ((info: QueueDropInfo) => void) | undefined
  private dropped = 0

  constructor(options: TransportEventQueueOptions) {
    this.route = options.route
    this.maxSize = options.maxSize
    this.priority = options.priority
    this.onDrop = options.onDrop
    this.overflowStrategy = options.overflowStrategy ?? 'drop_newest'
    this.capacity = Math.max(1, options.maxSize)
    this.buffer = new Array<SDKEvent | undefined>(this.capacity)
  }

  enqueue(event: SDKEvent): boolean {
    if (this.count >= this.capacity) {
      if (this.overflowStrategy === 'drop_oldest') {
        // Ring is full: tail == head. Read the evicted event for the drop
        // notification, overwrite its slot with the new event, advance head.
        const tail = this.head
        const evicted = this.buffer[tail]
        this.buffer[tail] = event
        this.head = (this.head + 1) % this.capacity
        this.dropped++
        this.onDrop?.({ route: this.route, reason: 'queue_full', count: 1, eventType: evicted?.type ?? event.type })
        return true
      }
      this.dropped++
      this.onDrop?.({ route: this.route, reason: 'queue_full', count: 1, eventType: event.type })
      return false
    }
    const tail = (this.head + this.count) % this.capacity
    this.buffer[tail] = event
    this.count++
    return true
  }

  drain(maxEvents: number): SDKEvent[] {
    const n = Math.min(maxEvents, this.count)
    if (n <= 0) return []
    const out: SDKEvent[] = new Array(n)
    for (let i = 0; i < n; i++) {
      const idx = (this.head + i) % this.capacity
      out[i] = this.buffer[idx] as SDKEvent
      this.buffer[idx] = undefined // release the reference for GC
    }
    this.head = (this.head + n) % this.capacity
    this.count -= n
    return out
  }

  /**
   * Put a failed batch back at the front of the queue, preserving order.
   *
   * When capacity is short, the HEAD of the requeued batch (its oldest
   * events) is dropped — identical semantics to the previous
   * per-event `unshift` loop, but O(batch) total instead of O(n²).
   */
  requeueFront(events: readonly SDKEvent[]): void {
    if (events.length === 0) return

    const available = Math.max(0, this.capacity - this.count)
    const acceptedCount = Math.min(events.length, available)
    const droppedCount = events.length - acceptedCount

    if (droppedCount > 0) {
      for (let i = 0; i < droppedCount; i++) {
        const event = events[i]
        this.dropped++
        this.onDrop?.({ route: this.route, reason: 'queue_full', count: 1, eventType: event?.type })
      }
    }

    // Prepend the accepted tail of the batch in reverse so its oldest
    // event lands exactly at the new head.
    for (let i = events.length - 1; i >= droppedCount; i--) {
      this.head = (this.head - 1 + this.capacity) % this.capacity
      this.buffer[this.head] = events[i]
      this.count++
    }
  }

  size(): number {
    return this.count
  }

  isEmpty(): boolean {
    return this.count === 0
  }

  clear(): void {
    this.buffer = new Array<SDKEvent | undefined>(this.capacity)
    this.head = 0
    this.count = 0
  }

  droppedCount(): number {
    return this.dropped
  }
}
