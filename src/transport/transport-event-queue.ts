import type { SDKEvent } from '../types/event.js'
import type { EnterpriseRoute } from './route-registry.js'

export type QueuePriority = 'high' | 'normal' | 'low'
export type QueueDropReason = 'queue_full' | 'event_too_large' | 'serialization_failed' | 'transport_disabled' | 'route_unavailable'

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
}

export class TransportEventQueue {
  readonly route: EnterpriseRoute
  readonly maxSize: number
  readonly priority: QueuePriority
  private readonly events: SDKEvent[] = []
  private readonly onDrop: ((info: QueueDropInfo) => void) | undefined
  private dropped = 0

  constructor(options: TransportEventQueueOptions) {
    this.route = options.route
    this.maxSize = options.maxSize
    this.priority = options.priority
    this.onDrop = options.onDrop
  }

  enqueue(event: SDKEvent): boolean {
    if (this.events.length >= this.maxSize) {
      this.dropped++
      this.onDrop?.({ route: this.route, reason: 'queue_full', count: 1, eventType: event.type })
      return false
    }
    this.events.push(event)
    return true
  }

  drain(maxEvents: number): SDKEvent[] {
    if (maxEvents <= 0 || this.events.length === 0) return []
    return this.events.splice(0, maxEvents)
  }

  requeueFront(events: readonly SDKEvent[]): void {
    for (let index = events.length - 1; index >= 0; index--) {
      const event = events[index]
      if (!event) continue
      if (this.events.length >= this.maxSize) {
        this.dropped++
        this.onDrop?.({ route: this.route, reason: 'queue_full', count: 1, eventType: event.type })
        continue
      }
      this.events.unshift(event)
    }
  }

  size(): number {
    return this.events.length
  }

  isEmpty(): boolean {
    return this.events.length === 0
  }

  clear(): void {
    this.events.length = 0
  }

  droppedCount(): number {
    return this.dropped
  }
}
