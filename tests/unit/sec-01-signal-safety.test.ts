import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { registerSignalHandlers, resetSignalHandlers } from '../../src/core/lifecycle.js'

describe('SEC-01: SIGTERM/SIGINT Graceful Shutdown & Deployment Safety', () => {
  it('registers and unregisters signal listeners cleanly without leaks', () => {
    const sigtermBefore = process.listenerCount('SIGTERM')
    const sigintBefore = process.listenerCount('SIGINT')

    registerSignalHandlers()
    assert.equal(process.listenerCount('SIGTERM'), sigtermBefore + 1)
    assert.equal(process.listenerCount('SIGINT'), sigintBefore + 1)

    // Idempotent call doesn't duplicate
    registerSignalHandlers()
    assert.equal(process.listenerCount('SIGTERM'), sigtermBefore + 1)
    assert.equal(process.listenerCount('SIGINT'), sigintBefore + 1)

    resetSignalHandlers()
    assert.equal(process.listenerCount('SIGTERM'), sigtermBefore)
    assert.equal(process.listenerCount('SIGINT'), sigintBefore)
  })

  it('exits with code 143 on SIGTERM when Pulse is the only handler in a process', (t, done) => {
    const child = spawn(process.execPath, [
      '--input-type=module',
      '-e',
      `
      import { registerSignalHandlers } from './dist/core/lifecycle.js'
      registerSignalHandlers()
      // Keep process alive
      const keepAlive = setInterval(() => {}, 1000)
      setTimeout(() => {
        process.emit('SIGTERM', 'SIGTERM')
      }, 50)
      `
    ], { stdio: ['pipe', 'pipe', 'pipe'] })

    child.on('exit', (code) => {
      assert.equal(code, 143, `Expected exit code 143, got ${code}`)
      done()
    })
  })

  it('allows application custom SIGTERM handler to dictate exit code when present', (t, done) => {
    const child = spawn(process.execPath, [
      '--input-type=module',
      '-e',
      `
      import { registerSignalHandlers } from './dist/core/lifecycle.js'
      registerSignalHandlers()
      process.on('SIGTERM', () => {
        console.log('APP_SIGTERM_RECEIVED')
        process.exit(42)
      })
      const keepAlive = setInterval(() => {}, 1000)
      setTimeout(() => {
        process.emit('SIGTERM', 'SIGTERM')
      }, 50)
      `
    ], { stdio: ['pipe', 'pipe', 'pipe'] })

    let appHandlerCalled = false
    child.stdout.on('data', (data) => {
      const text = data.toString()
      if (text.includes('APP_SIGTERM_RECEIVED')) {
        appHandlerCalled = true
      }
    })

    child.on('exit', (code) => {
      assert.ok(appHandlerCalled, 'Application custom handler must be called')
      assert.equal(code, 42, `Expected custom exit code 42, got ${code}`)
      done()
    })
  })
})
