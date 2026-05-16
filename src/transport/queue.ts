import type { Event } from "../types/event.js"

export class EventQueue {
  private queue: Event[] = []
  private maxSize: number
  private droppedCount = 0
  private deadLetterCount = 0
  private dropHandler: ((info: { reason: string; count: number }) => void) | null = null

  constructor(maxSize = 1000) {
    this.maxSize = maxSize
  }

  configure(maxSize: number) {
    this.maxSize = Math.max(1, Math.floor(maxSize))
    if (this.queue.length > this.maxSize) {
      const overflow = this.queue.length - this.maxSize
      this.queue.splice(0, overflow)
      this.droppedCount += overflow
    }
  }

  add(event: Event) {
    if (this.queue.length >= this.maxSize) {
      // Evict oldest — splice(0,1) is equivalent to shift() but signals intent
      this.queue.splice(0, 1)
      this.droppedCount += 1
      this.notifyDrop("queue_full", 1)
    }

    this.queue.push(event)
  }

  drain(batchSize: number): Event[] {
    return this.queue.splice(0, batchSize)
  }

  size() {
    return this.queue.length
  }

  getDroppedCount() {
    return this.droppedCount
  }

  getDeadLetterCount() {
    return this.deadLetterCount
  }

  drop(count: number) {
    const normalizedCount = Math.max(0, Math.floor(count))
    this.deadLetterCount += normalizedCount
    this.notifyDrop("dead_letter", normalizedCount)
  }

  filter(predicate: (event: Event) => boolean) {
    const before = this.queue.length
    this.queue = this.queue.filter(predicate)
    const dropped = before - this.queue.length
    this.droppedCount += dropped
    this.notifyDrop("filtered", dropped)
  }

  clear() {
    this.queue = []
  }

  onDrop(handler: ((info: { reason: string; count: number }) => void) | null) {
    this.dropHandler = handler
  }

  requeueFront(events: Event[]) {
    const available = Math.max(0, this.maxSize - this.queue.length)
    const toRestore = events.slice(0, available)
    const dropped = events.length - toRestore.length

    // Avoid spread operator — can blow call stack with large arrays
    // splice(0, 0, ...items) also has the same risk, so we build a new array
    this.queue = [...toRestore, ...this.queue].slice(0, this.maxSize)
    this.droppedCount += dropped
    this.notifyDrop("requeue_overflow", dropped)
  }


  private notifyDrop(reason: string, count: number) {
    if (count <= 0) return
    this.dropHandler?.({ reason, count })
  }
}

export const eventQueue = new EventQueue()
