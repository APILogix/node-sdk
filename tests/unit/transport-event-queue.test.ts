import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { TransportEventQueue, type QueueDropInfo } from '../../src/transport/transport-event-queue.js'
import type { SDKEvent } from '../../src/types/event.js'

function message(id: string): SDKEvent {
  return { type: 'message', eventId: id, message: id, severity: 'info', timestamp: 1 }
}

function fatal(id: string): SDKEvent {
  return {
    type: 'error', eventId: id, message: id, name: 'Error', stack: [],
    fingerprint: id, timestamp: 1, severity: 'fatal', context: {},
  }
}

function queue(strategy: 'drop_oldest' | 'drop_newest', drops: QueueDropInfo[]): TransportEventQueue {
  return new TransportEventQueue({
    route: 'errors', maxSize: 3, criticalReserve: 0, priority: 'high', overflowStrategy: strategy,
    onDrop: drop => drops.push(drop),
  })
}

describe('TransportEventQueue critical retention', () => {
  it('never lets ordinary traffic evict a fatal event with drop_oldest', () => {
    const drops: QueueDropInfo[] = []
    const q = queue('drop_oldest', drops)
    q.enqueue(fatal('fatal-1'))
    q.enqueue(message('normal-1'))
    q.enqueue(message('normal-2'))
    q.enqueue(message('normal-3'))

    assert.deepEqual(q.drain(3).map(event => event.eventId), ['fatal-1', 'normal-2', 'normal-3'])
    assert.equal(drops[0]?.eventId, 'normal-1')
    assert.equal(drops[0]?.critical, false)
  })
  it('admits an incoming fatal by evicting ordinary traffic under drop_newest', () => {
    const drops: QueueDropInfo[] = []
    const q = queue('drop_newest', drops)
    q.enqueue(message('normal-1'))
    q.enqueue(message('normal-2'))
    q.enqueue(message('normal-3'))

    assert.equal(q.enqueue(fatal('fatal-1')), true)
    assert.ok(q.drain(3).some(event => event.eventId === 'fatal-1'))
    assert.equal(drops[0]?.eventId, 'normal-1')
  })

  it('rejects a fatal only when every slot already contains critical telemetry', () => {
    const drops: QueueDropInfo[] = []
    const q = queue('drop_oldest', drops)
    q.enqueue(fatal('fatal-1'))
    q.enqueue(fatal('fatal-2'))
    q.enqueue(fatal('fatal-3'))

    assert.equal(q.enqueue(fatal('fatal-4')), false)
    assert.deepEqual(q.drain(3).map(event => event.eventId), ['fatal-1', 'fatal-2', 'fatal-3'])
    assert.equal(drops[0]?.eventId, 'fatal-4')
    assert.equal(drops[0]?.critical, true)
  })

  it('preserves fatal events when a failed ordinary batch is requeued', () => {
    const drops: QueueDropInfo[] = []
    const q = queue('drop_oldest', drops)
    q.enqueue(fatal('fatal-1'))
    q.enqueue(message('normal-1'))
    q.enqueue(message('normal-2'))
    q.requeueFront([message('retry-1'), message('retry-2')])

    const ids = q.drain(3).map(event => event.eventId)
    assert.ok(ids.includes('fatal-1'))
    assert.ok(!ids.includes('retry-1'))
    assert.ok(!ids.includes('retry-2'))
  })

  it('reserves configured slots from ordinary telemetry for critical events', () => {
    const drops: QueueDropInfo[] = []
    const q = new TransportEventQueue({
      route: 'errors',
      maxSize: 4,
      criticalReserve: 2,
      priority: 'high',
      overflowStrategy: 'drop_newest',
      onDrop: drop => drops.push(drop),
    })

    assert.equal(q.enqueue(message('normal-1')), true)
    assert.equal(q.enqueue(message('normal-2')), true)
    assert.equal(q.enqueue(message('normal-3')), false)
    assert.equal(q.enqueue(fatal('fatal-1')), true)
    assert.equal(q.enqueue(fatal('fatal-2')), true)
    assert.deepEqual(q.drain(4).map(event => event.eventId), [
      'normal-1', 'normal-2', 'fatal-1', 'fatal-2',
    ])
    assert.equal(drops[0]?.eventId, 'normal-3')
  })
})
