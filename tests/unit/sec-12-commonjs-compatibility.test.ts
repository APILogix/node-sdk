import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { join } from 'node:path'

describe('SEC-12: CommonJS & ESM Interoperability', () => {
  const require = createRequire(import.meta.url)
  const packageRoot = join(process.cwd())

  it('allows CommonJS consumer to require the package root', () => {
    const sdkCjs = require(packageRoot)
    assert.ok(sdkCjs, 'CommonJS require should succeed')
    assert.equal(typeof sdkCjs.init, 'function', 'Should export init')
    assert.equal(typeof sdkCjs.captureException, 'function', 'Should export captureException')
    assert.equal(typeof sdkCjs.captureMetric, 'function', 'Should export captureMetric')
    assert.equal(typeof sdkCjs.captureRequest, 'function', 'Should export captureRequest')
    assert.equal(typeof sdkCjs.captureLog, 'function', 'Should export captureLog')
    assert.equal(typeof sdkCjs.startSpan, 'function', 'Should export startSpan')
    assert.equal(typeof sdkCjs.withSpan, 'function', 'Should export withSpan')
    assert.equal(typeof sdkCjs.LynkTrace, 'object', 'Should export LynkTrace facade')
    assert.equal(typeof sdkCjs.default, 'object', 'Should export default LynkTrace facade')
  })

  it('allows CommonJS consumer to call facade methods fail-open', () => {
    const sdkCjs = require(packageRoot)
    assert.doesNotThrow(() => {
      sdkCjs.LynkTrace.captureMessage('test-cjs-message')
    })
    const health = sdkCjs.LynkTrace.getHealth()
    assert.ok(health, 'getHealth should return snapshot')
    assert.equal(typeof health.initialized, 'boolean')
  })

  it('allows ESM consumer to import the package root concurrently', async () => {
    const indexPath = join(packageRoot, 'dist', 'index.js')
    const sdkEsm = await import(`file://${indexPath.replace(/\\/g, '/')}`)
    assert.ok(sdkEsm, 'ESM import should succeed')
    assert.equal(typeof sdkEsm.init, 'function')
    assert.equal(typeof sdkEsm.captureException, 'function')
    assert.equal(typeof sdkEsm.LynkTrace, 'object')
  })
})
