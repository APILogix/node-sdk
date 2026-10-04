import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { parseAndApplyEnv, isPulseScopedKey, resetEnvLoaderState } from '../../src/utils/env-loader.js'

describe('SEC-10: Implicit .env Loading Host Side-Effect Safety', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    resetEnvLoaderState()
  })

  afterEach(() => {
    process.env = { ...originalEnv }
    resetEnvLoaderState()
  })

  it('correctly identifies Pulse-scoped environment keys', () => {
    assert.strictEqual(isPulseScopedKey('PULSE_API_KEY'), true)
    assert.strictEqual(isPulseScopedKey('PULSE_ENDPOINT'), true)
    assert.strictEqual(isPulseScopedKey('PULSE_BASE_URL'), true)
    assert.strictEqual(isPulseScopedKey('SDK_BASE_URL'), true)

    assert.strictEqual(isPulseScopedKey('PORT'), false)
    assert.strictEqual(isPulseScopedKey('DATABASE_URL'), false)
    assert.strictEqual(isPulseScopedKey('JWT_SECRET'), false)
    assert.strictEqual(isPulseScopedKey('NODE_ENV'), false)
  })

  it('does NOT pollute process.env with host application variables in pulseOnly mode', () => {
    delete process.env['PULSE_API_KEY']
    delete process.env['PULSE_ENDPOINT']
    delete process.env['HOST_DATABASE_URL']
    delete process.env['HOST_PORT']

    const mockEnvFile = `
HOST_PORT=8080
HOST_DATABASE_URL=postgres://user:pass@localhost:5432/db
PULSE_API_KEY=pulse_secret_key_999
PULSE_ENDPOINT=https://custom-ingest.domain.com
`

    parseAndApplyEnv(mockEnvFile, { pulseOnly: true })

    // Pulse keys should be set
    assert.strictEqual(process.env['PULSE_API_KEY'], 'pulse_secret_key_999')
    assert.strictEqual(process.env['PULSE_ENDPOINT'], 'https://custom-ingest.domain.com')

    // Host application keys must NOT be set
    assert.strictEqual(process.env['HOST_PORT'], undefined)
    assert.strictEqual(process.env['HOST_DATABASE_URL'], undefined)
  })

  it('allows unconstrained parsing when pulseOnly is not set (explicit parsing)', () => {
    delete process.env['EXPLICIT_KEY']
    parseAndApplyEnv('EXPLICIT_KEY=custom_value')
    assert.strictEqual(process.env['EXPLICIT_KEY'], 'custom_value')
  })
})
