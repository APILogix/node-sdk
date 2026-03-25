type Event = any

class EventQueue {
  private queue: Event[] = []
  private maxSize = 1000

  add(event: Event) {
    if (this.queue.length >= this.maxSize) {
      //  drop oldest (backpressure strategy)
      this.queue.shift()
    }

    this.queue.push(event)
  }

  drain(batchSize: number): Event[] {
    return this.queue.splice(0, batchSize)
  }

  size() {
    return this.queue.length
  }
}

export const eventQueue = new EventQueue()