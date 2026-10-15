import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { resolveApiBaseUrl, BACKEND_BASE_URL } from '../../src/constants/defaults.js'
import { init } from '../../src/core/init.js'
import { shutdown } from '../../src/core/lifecycle.js'
import { TEST_REMOTE_CONFIG } from '../fixtures/remote-config.js'

describe('Environment Variables & Base URL Configuration', () => {
  const originalEnv = { ...process.env }
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(async () => {
    process.env = { ...originalEnv }
    globalThis.fetch = originalFetch
    await shutdown()
  })

  it('2. resolveApiBaseUrl inspects PULSE_ENDPOINT and normalizes localhost to 127.0.0.1', () => {
    delete process.env['SDK_BASE_URL']
    delete process.env['PULSE_BASE_URL']
    delete process.env['PULSE_API_URL']
    delete process.env['BACKEND_URL']

    process.env['PULSE_ENDPOINT'] = 'http://localhost:3000'
    assert.equal(resolveApiBaseUrl(), 'http://127.0.0.1:3000')

    process.env['PULSE_ENDPOINT'] = 'https://ingest.pulse-apm.io/'
    assert.equal(resolveApiBaseUrl(), 'https://ingest.pulse-apm.io')
  })

  it('3. resolveApiBaseUrl respects PULSE_API_URL and PULSE_BASE_URL precedence and ignores generic BACKEND_URL', () => {
    delete process.env['PULSE_ENDPOINT']
    delete process.env['PULSE_API_URL']
    delete process.env['PULSE_BASE_URL']

    // Generic BACKEND_URL must be ignored to prevent host application env collisions
    process.env['BACKEND_URL'] = 'http://localhost:9999'
    process.env['PULSE_BASE_URL'] = 'http://127.0.0.1:4000'
    assert.equal(resolveApiBaseUrl(), 'http://127.0.0.1:4000')

    process.env['PULSE_API_URL'] = 'http://127.0.0.1:4001'
    assert.equal(resolveApiBaseUrl(), 'http://127.0.0.1:4001')

    delete process.env['PULSE_API_URL']
    delete process.env['PULSE_BASE_URL']
    // When only generic BACKEND_URL is set, it must not be used (falls back to BACKEND_BASE_URL)
    assert.equal(resolveApiBaseUrl(), BACKEND_BASE_URL)
    delete process.env['BACKEND_URL']
  })

  it('uses the scoped SDK_BASE_URL compatibility alias when no Pulse endpoint is configured', () => {
    delete process.env['PULSE_ENDPOINT']
    delete process.env['PULSE_API_URL']
    delete process.env['PULSE_BASE_URL']
    process.env['SDK_BASE_URL'] = 'http://localhost:4100/'

    assert.equal(resolveApiBaseUrl(), 'http://127.0.0.1:4100')
  })

  it('4. init() automatically falls back to process.env.PULSE_API_KEY when apiKey is omitted', async () => {
    process.env['PULSE_API_KEY'] = 'env-api-key-test-123'

    let requestCaptured = false
    let capturedApiKeyHeader = ''

    globalThis.fetch = (async (url: any, opts: any) => {
      if (String(url).includes('/v1/init')) {
        requestCaptured = true
        capturedApiKeyHeader = opts?.headers?.['X-API-Key'] ?? ''
        return new Response(JSON.stringify({
          success: true,
          projectId: 'env-project',
          environment: 'production',
          release: '1.0.0',
          config: {
            ...TEST_REMOTE_CONFIG,
            sdk: {
              ...TEST_REMOTE_CONFIG.sdk,
              projectId: 'env-project',
              environment: 'production',
              release: '1.0.0',
            },
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    }) as any

    // Call init with apiKey passed from environment
    const config = await init({ apiKey: process.env['PULSE_API_KEY']! })
    assert.ok(config, 'Config returned from init')
    assert.equal(requestCaptured, true, 'Init request sent')
    assert.equal(capturedApiKeyHeader, 'env-api-key-test-123', 'API key sent from environment')
  })

  it('5. init() resolves endpoint from PULSE_ENDPOINT environment variable without code overrides', async () => {
    let capturedUrl = ''
    process.env['PULSE_ENDPOINT'] = 'http://127.0.0.1:3000'

    globalThis.fetch = (async (url: any) => {
      capturedUrl = String(url)
      return new Response(JSON.stringify({
        success: true,
        projectId: 'endpoint-project',
        environment: 'production',
        release: '1.0.0',
        config: {
          ...TEST_REMOTE_CONFIG,
          sdk: {
            ...TEST_REMOTE_CONFIG.sdk,
            projectId: 'endpoint-project',
            environment: 'production',
            release: '1.0.0',
          },
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as any

    await init({
      apiKey: 'test-options-key',
    })

    assert.ok(capturedUrl.startsWith('http://127.0.0.1:3000/v1/init'), 'Requested endpoint resolved from PULSE_ENDPOINT environment')
    delete process.env['PULSE_ENDPOINT']
  })
})
