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
  readonly eventId?: string | undefined
  readonly critical?: boolean | undefined
}

export interface TransportEventQueueOptions {
  readonly route: EnterpriseRoute
  readonly maxSize: number
  /** Slots unavailable to ordinary telemetry and reserved for critical events. */
  readonly criticalReserve: number
  readonly priority: QueuePriority
  readonly onDrop?: (info: QueueDropInfo) => void
  readonly overflowStrategy: QueueOverflowStrategy
}

/** Bounded ring-buffer queue with backend-controlled critical capacity. */
export class TransportEventQueue {
  readonly route: EnterpriseRoute
  readonly maxSize: number
  readonly priority: QueuePriority
  private readonly overflowStrategy: QueueOverflowStrategy
  private readonly criticalReserve: number
  private buffer: (SDKEvent | undefined)[]
  private readonly capacity: number
  private head = 0
  private count = 0
  private criticalCount = 0
  private readonly onDrop: ((info: QueueDropInfo) => void) | undefined
  private dropped = 0

  constructor(options: TransportEventQueueOptions) {
    if (!Number.isInteger(options.maxSize) || options.maxSize < 1) {
      throw new RangeError('Transport queue maxSize must be a positive integer')
    }
    if (!Number.isInteger(options.criticalReserve)
      || options.criticalReserve < 0
      || options.criticalReserve > options.maxSize) {
      throw new RangeError('Transport queue criticalReserve must be an integer within queue capacity')
    }

    this.route = options.route
    this.maxSize = options.maxSize
    this.priority = options.priority
    this.onDrop = options.onDrop
    this.overflowStrategy = options.overflowStrategy
    this.capacity = options.maxSize
    this.criticalReserve = options.criticalReserve
    this.buffer = new Array<SDKEvent | undefined>(this.capacity)
  }

  enqueue(event: SDKEvent): boolean {
    const incomingCritical = isCritical(event)
    const ordinaryCount = this.count - this.criticalCount
    const ordinaryCapacity = this.capacity - this.criticalReserve

    // Preserve the configured reserve even while the ring still has free slots.
    if (!incomingCritical && ordinaryCount >= ordinaryCapacity) {
      if (this.overflowStrategy === 'drop_oldest' && ordinaryCapacity > 0) {
        const offset = this.findOldestNonCritical()
        if (offset >= 0) {
          const evicted = this.removeAt(offset)
          this.append(event)
          this.notifyDrop(evicted ?? event)
          return true
        }
      }
      this.notifyDrop(event)
      return false
    }

    if (this.count >= this.capacity) {
      const evictOffset = this.findOldestNonCritical()
      if ((incomingCritical || this.overflowStrategy === 'drop_oldest') && evictOffset >= 0) {
        const evicted = this.removeAt(evictOffset)
        this.append(event)
        this.notifyDrop(evicted ?? event)
        return true
      }
      this.notifyDrop(event)
      return false
    }

    this.append(event)
    return true
  }

  drain(maxEvents: number): SDKEvent[] {
    const amount = Math.min(maxEvents, this.count)
    if (amount <= 0) return []
    const events: SDKEvent[] = new Array(amount)
    for (let index = 0; index < amount; index++) {
      const slot = (this.head + index) % this.capacity
      const event = this.buffer[slot] as SDKEvent
      events[index] = event
      if (isCritical(event)) this.criticalCount--
      this.buffer[slot] = undefined
    }
    this.head = (this.head + amount) % this.capacity
    this.count -= amount
    return events
  }

  /**
   * Requeue failed events at the front while preserving critical reserve.
   * Runs in O(n + k) linear time instead of O(n * k) under queue pressure (SEC-07).
   */
  requeueFront(events: readonly SDKEvent[]): void {
    if (!events || events.length === 0) return

    // Pass 1: Classify events to requeue in reverse order (matching prepend order)
    const toPrepend: SDKEvent[] = []
    let ordinaryCount = this.count - this.criticalCount
    const ordinaryCapacity = this.capacity - this.criticalReserve
    let totalCount = this.count
    let nonCriticalInQueue = ordinaryCount
    let evictionsNeeded = 0

    for (let index = events.length - 1; index >= 0; index--) {
      const event = events[index]
      if (!event) continue
      const critical = isCritical(event)

      if (!critical) {
        if (ordinaryCount >= ordinaryCapacity || totalCount >= this.capacity) {
          this.notifyDrop(event)
          continue
        }
        ordinaryCount++
        totalCount++
        toPrepend.push(event)
      } else {
        // Critical event
        if (totalCount >= this.capacity) {
          if (nonCriticalInQueue > evictionsNeeded) {
            evictionsNeeded++
            toPrepend.push(event)
          } else {
            this.notifyDrop(event)
          }
        } else {
          totalCount++
          toPrepend.push(event)
        }
      }
    }

    if (toPrepend.length === 0) return

    // Pass 2: If evictions are needed, evict the oldest non-critical events in a single O(n) pass
    if (evictionsNeeded > 0) {
      const newBuffer = new Array<SDKEvent | undefined>(this.capacity)
      let newCount = 0
      let evicted = 0

      for (let offset = 0; offset < this.count; offset++) {
        const slot = (this.head + offset) % this.capacity
        const item = this.buffer[slot] as SDKEvent
        if (!item) continue

        if (evicted < evictionsNeeded && !isCritical(item)) {
          evicted++
          this.notifyDrop(item)
        } else {
          newBuffer[newCount++] = item
        }
      }

      this.buffer = newBuffer
      this.head = 0
      this.count = newCount
    }

    // Pass 3: Prepend all accepted events into the buffer in O(k)
    for (let i = 0; i < toPrepend.length; i++) {
      this.prepend(toPrepend[i]!)
    }
  }

  private append(event: SDKEvent): void {
    const tail = (this.head + this.count) % this.capacity
    this.buffer[tail] = event
    this.count++
    if (isCritical(event)) this.criticalCount++
  }

  private prepend(event: SDKEvent): void {
    this.head = (this.head - 1 + this.capacity) % this.capacity
    this.buffer[this.head] = event
    this.count++
    if (isCritical(event)) this.criticalCount++
  }

  private findOldestNonCritical(): number {
    for (let offset = 0; offset < this.count; offset++) {
      const event = this.buffer[(this.head + offset) % this.capacity]
      if (event && !isCritical(event)) return offset
    }
    return -1
  }

  private removeAt(offset: number): SDKEvent | undefined {
    if (offset < 0 || offset >= this.count) return undefined
    const removed = this.buffer[(this.head + offset) % this.capacity]
    if (offset === 0) {
      this.buffer[this.head] = undefined
      this.head = (this.head + 1) % this.capacity
    } else {
      for (let index = offset; index < this.count - 1; index++) {
        const destination = (this.head + index) % this.capacity
        const source = (this.head + index + 1) % this.capacity
        this.buffer[destination] = this.buffer[source]
      }
      this.buffer[(this.head + this.count - 1) % this.capacity] = undefined
    }
    this.count--
    if (removed && isCritical(removed)) this.criticalCount--
    return removed
  }

  private notifyDrop(event: SDKEvent): void {
    this.dropped++
    this.onDrop?.({
      route: this.route,
      reason: 'queue_full',
      count: 1,
      eventType: event.type,
      eventId: event.eventId,
      critical: isCritical(event),
    })
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
    this.criticalCount = 0
  }

  droppedCount(): number {
    return this.dropped
  }
}

function isCritical(event: SDKEvent): boolean {
  if (event.type === 'error') return event.severity === 'fatal'
  if (event.type === 'log') return event.level === 'fatal'
  return event.type === 'cron_checkin' && event.status === 'error'
}
