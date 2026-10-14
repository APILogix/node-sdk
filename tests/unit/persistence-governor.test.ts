import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PersistenceGovernor } from '../../src/storage/persistence-governor.js'
import type { Event } from '../../src/types/event.js'

function logEvent(id: string): Event {
  return {
    type: 'log',
    eventId: id,
    level: 'info',
    message: 'test',
    timestamp: Date.now(),
  } as Event
}

describe('PersistenceGovernor', () => {
  it('honors remote-config budget updates at runtime', () => {
    const governor = new PersistenceGovernor({
      maxPersistPerMinute: 1,
      enableAdaptive: false,
      budgetExceededLogIntervalMs: 60_000,
    })

    assert.equal(governor.shouldPersist(logEvent('evt-1')), true)
    assert.equal(governor.shouldPersist(logEvent('evt-2')), false)

    governor.configure({
      maxPersistPerMinute: 2,
      adaptive: false,
      budgetExceededLogIntervalMs: 60_000,
    })

    assert.equal(governor.shouldPersist(logEvent('evt-3')), true)
    assert.equal(governor.shouldPersist(logEvent('evt-4')), false)
  })

  it('bounds sliding window tracking under extreme critical error bursts', () => {
    const governor = new PersistenceGovernor({
      maxPersistPerMinute: 10,
      enableAdaptive: false,
    })

    const errorEvent = (id: string): Event => ({
      type: 'error',
      eventId: id,
      level: 'error',
      message: 'crash',
      timestamp: Date.now(),
    } as unknown as Event)

    // Send 3000 critical events
    for (let i = 0; i < 3000; i++) {
      const persisted = governor.shouldPersist(errorEvent(`err-${i}`))
      assert.equal(persisted, true, 'critical events must always persist')
    }

    const stats = governor.getStats()
    assert.equal(stats.totalPersisted, 3000)
    // The internal window tracking is bounded to prevent unbounded memory leaks
    assert.ok(stats.currentPersistRate <= 1000, `Tracked window rate must be bounded, got ${stats.currentPersistRate}`)

    // Reset clears state
    governor.reset()
    const resetStats = governor.getStats()
    assert.equal(resetStats.totalPersisted, 0)
    assert.equal(resetStats.currentPersistRate, 0)
  })
})
