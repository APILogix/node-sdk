import type { SDKEvent } from '../types/event.js'
import type { EnterpriseRoute } from './route-registry.js'

export type QueuePriority = 'high' | 'normal' | 'low'
export type QueueDropReason =
  | 'queue_full'
  | 'event_too_large'
  | 'serialization_failed'
  | 'transport_disabled'
  | 'route_unavailable'
  | 'route_unconfigured'
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

interface SequencedEvent {
  readonly event: SDKEvent
  readonly seq: number
}

/** O(1) circular ring buffer with zero element shifting. */
class InternalRing {
  private buf: (SequencedEvent | undefined)[]
  private head = 0
  private len = 0

  constructor(private readonly cap: number) {
    this.buf = new Array<SequencedEvent | undefined>(cap)
  }

  get length(): number {
    return this.len
  }

  pushBack(item: SequencedEvent): void {
    const tail = (this.head + this.len) % this.cap
    this.buf[tail] = item
    this.len++
  }

  pushFront(item: SequencedEvent): void {
    this.head = (this.head - 1 + this.cap) % this.cap
    this.buf[this.head] = item
    this.len++
  }

  popFront(): SequencedEvent | undefined {
    if (this.len === 0) return undefined
    const item = this.buf[this.head]
    this.buf[this.head] = undefined
    this.head = (this.head + 1) % this.cap
    this.len--
    return item
  }

  peekFront(): SequencedEvent | undefined {
    return this.len === 0 ? undefined : this.buf[this.head]
  }

  clear(): void {
    this.buf = new Array<SequencedEvent | undefined>(this.cap)
    this.head = 0
    this.len = 0
  }
}

/** Bounded O(1) dual-ring queue with backend-controlled critical capacity. */
export class TransportEventQueue {
  readonly route: EnterpriseRoute
  readonly maxSize: number
  readonly priority: QueuePriority
  private readonly overflowStrategy: QueueOverflowStrategy
  private readonly criticalReserve: number
  private readonly capacity: number
  private readonly criticalRing: InternalRing
  private readonly ordinaryRing: InternalRing
  private nextTailSeq = 1
  private nextHeadSeq = 0
  private readonly onDrop: ((info: QueueDropInfo) => void) | undefined
  private dropped = 0

  constructor(options: TransportEventQueueOptions) {
    if (!Number.isInteger(options.maxSize) || options.maxSize < 1) {
      throw new RangeError('Transport queue maxSize must be a positive integer')
    }
    if (
      !Number.isInteger(options.criticalReserve) ||
      options.criticalReserve < 0 ||
      options.criticalReserve > options.maxSize
    ) {
      throw new RangeError('Transport queue criticalReserve must be an integer within queue capacity')
    }

    this.route = options.route
    this.maxSize = options.maxSize
    this.priority = options.priority
    this.onDrop = options.onDrop
    this.overflowStrategy = options.overflowStrategy
    this.capacity = options.maxSize
    this.criticalReserve = options.criticalReserve
    this.criticalRing = new InternalRing(this.capacity)
    this.ordinaryRing = new InternalRing(this.capacity)
  }

  enqueue(event: SDKEvent): boolean {
    const incomingCritical = isCritical(event)
    const ordinaryCount = this.ordinaryRing.length
    const ordinaryCapacity = this.capacity - this.criticalReserve
    const totalCount = this.criticalRing.length + ordinaryCount

    // 1. Ordinary event hitting ordinary capacity limit (preserving criticalReserve)
    if (!incomingCritical && ordinaryCount >= ordinaryCapacity) {
      if (this.overflowStrategy === 'drop_oldest' && ordinaryCapacity > 0 && ordinaryCount > 0) {
        const evicted = this.ordinaryRing.popFront()!
        this.ordinaryRing.pushBack({ event, seq: this.nextTailSeq++ })
        this.notifyDrop(evicted.event)
        return true
      }
      this.notifyDrop(event)
      return false
    }

    // 2. Total queue at full capacity
    if (totalCount >= this.capacity) {
      if ((incomingCritical || this.overflowStrategy === 'drop_oldest') && ordinaryCount > 0) {
        const evicted = this.ordinaryRing.popFront()!
        if (incomingCritical) {
          this.criticalRing.pushBack({ event, seq: this.nextTailSeq++ })
        } else {
          this.ordinaryRing.pushBack({ event, seq: this.nextTailSeq++ })
        }
        this.notifyDrop(evicted.event)
        return true
      }
      this.notifyDrop(event)
      return false
    }

    // 3. Normal O(1) append
    if (incomingCritical) {
      this.criticalRing.pushBack({ event, seq: this.nextTailSeq++ })
    } else {
      this.ordinaryRing.pushBack({ event, seq: this.nextTailSeq++ })
    }
    return true
  }

  drain(maxEvents: number): SDKEvent[] {
    const totalCount = this.criticalRing.length + this.ordinaryRing.length
    const amount = Math.min(maxEvents, totalCount)
    if (amount <= 0) return []

    const events: SDKEvent[] = new Array(amount)
    for (let i = 0; i < amount; i++) {
      const crit = this.criticalRing.peekFront()
      const ord = this.ordinaryRing.peekFront()

      if (crit && (!ord || crit.seq < ord.seq)) {
        events[i] = this.criticalRing.popFront()!.event
      } else {
        events[i] = this.ordinaryRing.popFront()!.event
      }
    }
    return events
  }

  /**
   * Requeue failed events at the front while preserving critical reserve.
   * Strict O(k) time with zero full-buffer allocations or array shifts.
   */
  requeueFront(events: readonly SDKEvent[]): void {
    if (!events || events.length === 0) return
    const ordinaryCapacity = this.capacity - this.criticalReserve

    for (let index = events.length - 1; index >= 0; index--) {
      const event = events[index]
      if (!event) continue
      const critical = isCritical(event)
      const totalCount = this.criticalRing.length + this.ordinaryRing.length

      if (!critical) {
        if (this.ordinaryRing.length >= ordinaryCapacity || totalCount >= this.capacity) {
          this.notifyDrop(event)
          continue
        }
        this.ordinaryRing.pushFront({ event, seq: this.nextHeadSeq-- })
      } else {
        if (totalCount >= this.capacity) {
          if (this.ordinaryRing.length > 0) {
            const evicted = this.ordinaryRing.popFront()!
            this.notifyDrop(evicted.event)
            this.criticalRing.pushFront({ event, seq: this.nextHeadSeq-- })
          } else {
            this.notifyDrop(event)
          }
        } else {
          this.criticalRing.pushFront({ event, seq: this.nextHeadSeq-- })
        }
      }
    }
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

  getSize(): number {
    return this.criticalRing.length + this.ordinaryRing.length
  }

  size(): number {
    return this.criticalRing.length + this.ordinaryRing.length
  }

  isEmpty(): boolean {
    return this.size() === 0
  }

  clear(): void {
    this.criticalRing.clear()
    this.ordinaryRing.clear()
    this.nextTailSeq = 1
    this.nextHeadSeq = 0
  }

  droppedCount(): number {
    return this.dropped
  }
}

function isCritical(event: SDKEvent): boolean {
  if (event.type === 'error') {
    return event.severity === 'fatal' || (event as any).classification?.fatal === true
  }
  if (event.type === 'log') return event.level === 'fatal'
  return event.type === 'cron_checkin' && event.status === 'error'
}
