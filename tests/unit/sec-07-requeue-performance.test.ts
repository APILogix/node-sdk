import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { TransportEventQueue, type QueueDropInfo } from '../../src/transport/transport-event-queue.js'
import type { SDKEvent } from '../../src/types/event.js'

function makeMessage(id: string): SDKEvent {
  return { type: 'message', eventId: id, message: id, severity: 'info', timestamp: 1 }
}

function makeFatal(id: string): SDKEvent {
  return {
    type: 'error',
    eventId: id,
    message: id,
    name: 'Error',
    stack: [],
    fingerprint: id,
    timestamp: 1,
    severity: 'fatal',
    context: {},
    classification: { unhandled: false, fatal: true, crash: false },
  }
}

describe('SEC-07: requeueFront O(n+k) Performance & Correctness', () => {
  it('correctly maintains order of prepended events', () => {
    const drops: QueueDropInfo[] = []
    const q = new TransportEventQueue({
      route: 'errors',
      maxSize: 10,
      criticalReserve: 0,
      priority: 'high',
      overflowStrategy: 'drop_oldest',
      onDrop: d => drops.push(d),
    })

    q.enqueue(makeMessage('msg-3'))
    q.enqueue(makeMessage('msg-4'))

    // Requeue [msg-1, msg-2]
    q.requeueFront([makeMessage('msg-1'), makeMessage('msg-2')])

    const drained = q.drain(10).map(e => e.eventId)
    assert.deepStrictEqual(drained, ['msg-1', 'msg-2', 'msg-3', 'msg-4'])
  })

  it('evicts non-critical events in linear time when critical events are requeued into a full queue', () => {
    const drops: QueueDropInfo[] = []
    const q = new TransportEventQueue({
      route: 'errors',
      maxSize: 4,
      criticalReserve: 0,
      priority: 'high',
      overflowStrategy: 'drop_oldest',
      onDrop: d => drops.push(d),
    })

    // Fill queue with 4 normal messages
    q.enqueue(makeMessage('msg-1'))
    q.enqueue(makeMessage('msg-2'))
    q.enqueue(makeMessage('msg-3'))
    q.enqueue(makeMessage('msg-4'))

    // Requeue 2 fatal events
    q.requeueFront([makeFatal('fatal-1'), makeFatal('fatal-2')])

    // Oldest messages (msg-1, msg-2) should have been evicted
    assert.strictEqual(drops.length, 2)
    assert.strictEqual(drops[0]?.eventId, 'msg-1')
    assert.strictEqual(drops[1]?.eventId, 'msg-2')

    const drained = q.drain(4).map(e => e.eventId)
    assert.deepStrictEqual(drained, ['fatal-1', 'fatal-2', 'msg-3', 'msg-4'])
  })

  it('completes large batch requeue under high queue pressure without quadratic stall', () => {
    const drops: QueueDropInfo[] = []
    const capacity = 2000
    const q = new TransportEventQueue({
      route: 'errors',
      maxSize: capacity,
      criticalReserve: 100,
      priority: 'high',
      overflowStrategy: 'drop_oldest',
      onDrop: d => drops.push(d),
    })

    for (let i = 0; i < capacity - 100; i++) {
      q.enqueue(makeMessage(`existing-${i}`))
    }

    const failedBatch: SDKEvent[] = []
    for (let i = 0; i < 500; i++) {
      failedBatch.push(i % 5 === 0 ? makeFatal(`retry-fatal-${i}`) : makeMessage(`retry-msg-${i}`))
    }

    const start = performance.now()
    q.requeueFront(failedBatch)
    const elapsed = performance.now() - start

    // Under O(n + k), 2000 items with 500 requeued takes < 15ms in JS; O(n * k) with array shifts would take substantially longer
    assert.ok(elapsed < 50, `requeueFront took ${elapsed.toFixed(2)}ms, must be < 50ms`)
  })
})
