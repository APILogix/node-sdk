import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  setupGlobalErrorHandlers,
  resetGlobalErrorHandlers,
} from '../../src/instrumentation/global-errors.js'
import { parseStack } from '../../src/processors/stack-parser.js'

describe('SEC-11: Global Error.stackTraceLimit Immutability', () => {
  const initialLimit = Error.stackTraceLimit

  beforeEach(() => {
    resetGlobalErrorHandlers()
  })

  afterEach(() => {
    resetGlobalErrorHandlers()
    Error.stackTraceLimit = initialLimit
  })

  it('never mutates global Error.stackTraceLimit when error handlers are setup', () => {
    const customLimit = 22
    Error.stackTraceLimit = customLimit

    setupGlobalErrorHandlers()

    assert.equal(
      Error.stackTraceLimit,
      customLimit,
      'Error.stackTraceLimit must remain completely untouched by setupGlobalErrorHandlers (SEC-11)'
    )
  })

  it('preserves host application stackTraceLimit through setup and reset cycles', () => {
    const hostLimit = 7
    Error.stackTraceLimit = hostLimit

    setupGlobalErrorHandlers()
    assert.equal(Error.stackTraceLimit, hostLimit)

    resetGlobalErrorHandlers()
    assert.equal(Error.stackTraceLimit, hostLimit)
  })

  it('still parses structured stack frames accurately when host has a custom limit', () => {
    Error.stackTraceLimit = 10
    const err = new Error('Test error with custom stack trace limit')
    const frames = parseStack(err.stack, err)

    assert.ok(Array.isArray(frames), 'Frames should be parsed as an array')
    assert.ok(frames.length > 0, 'Should extract at least one stack frame')
    assert.ok(frames[0] && (frames[0].function || frames[0].filename), 'Frames should have function or filename')
  })
})
