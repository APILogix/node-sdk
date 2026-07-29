import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { patchEventEmitter, unpatchEventEmitter } from '../../src/instrumentation/event-emitter-patch.js'

afterEach(() => unpatchEventEmitter())

describe('EventEmitter context patch', () => {
  it('removes wrapped listeners through their original callback', () => {
    patchEventEmitter()
    const emitter = new EventEmitter()
    const methods = ['on', 'once', 'prependListener', 'prependOnceListener'] as const

    for (const method of methods) {
      const listener = () => undefined
      emitter[method]('event', listener)
      assert.deepEqual(emitter.listeners('event'), [listener])
      emitter.removeListener('event', listener)
      assert.equal(emitter.listenerCount('event'), 0, `${method} listener leaked`)
    }
  })

  it('keeps once semantics during recursive emission', () => {
    patchEventEmitter()
    const emitter = new EventEmitter()
    let calls = 0
    emitter.once('event', () => {
      calls++
      emitter.emit('event')
    })

    emitter.emit('event')
    assert.equal(calls, 1)
    assert.equal(emitter.listenerCount('event'), 0)
  })

  it('does not leak process listeners registered while patched', () => {
    patchEventEmitter()
    const baseline = process.listenerCount('uncaughtException')
    const listener = () => undefined
    process.on('uncaughtException', listener)
    process.removeListener('uncaughtException', listener)
    assert.equal(process.listenerCount('uncaughtException'), baseline)
  })
})
