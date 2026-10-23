import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { PersistentStorage, persistentStorage } from '../../src/storage/persistent-storage.js'
import { wrapHandler } from '../../src/serverless/handler.js'
import { init, shutdown, LynkTrace } from '../../src/index.js'
import { client } from '../../src/core/client.js'
import { TEST_REMOTE_CONFIG } from '../fixtures/remote-config.js'

describe('Serverless & Read-Only Storage Resilience', () => {
  const originalEnv = { ...process.env }

  beforeEach(async () => {
    await shutdown(500).catch(() => {})
  })

  afterEach(async () => {
    process.env = { ...originalEnv }
    await shutdown(500).catch(() => {})
  })

  describe('Directory Resolution & Environment Detection', () => {
    it('resolves default directory to /tmp when running in AWS Lambda', () => {
      process.env.AWS_LAMBDA_FUNCTION_NAME = 'my-test-lambda'
      const storage = new PersistentStorage()
      storage.configure()
      // Should target tmpdir under serverless
      const valid = storage.directory.startsWith(join(tmpdir(), 'telemetry-sdk', 'events')) ||
                    storage.directory.startsWith(join(tmpdir(), 'pulse-sdk', 'events'))
      assert.ok(valid, `Storage directory ${storage.directory} should be in tmpdir`)
    })

    it('resolves default directory to /tmp when running in Google Cloud Functions', () => {
      delete process.env.AWS_LAMBDA_FUNCTION_NAME
      process.env.K_SERVICE = 'my-cloud-run-service'
      const storage = new PersistentStorage()
      storage.configure()
      const valid = storage.directory.startsWith(join(tmpdir(), 'telemetry-sdk', 'events')) ||
                    storage.directory.startsWith(join(tmpdir(), 'pulse-sdk', 'events'))
      assert.ok(valid, `Storage directory ${storage.directory} should be in tmpdir`)
    })

    it('resolves default directory to /tmp when running in Azure Functions', () => {
      delete process.env.AWS_LAMBDA_FUNCTION_NAME
      delete process.env.K_SERVICE
      process.env.FUNCTIONS_WORKER_RUNTIME = 'node'
      const storage = new PersistentStorage()
      storage.configure()
      const valid = storage.directory.startsWith(join(tmpdir(), 'telemetry-sdk', 'events')) ||
                    storage.directory.startsWith(join(tmpdir(), 'pulse-sdk', 'events'))
      assert.ok(valid, `Storage directory ${storage.directory} should be in tmpdir`)
    })

    it('resolves default directory to /tmp when running in Vercel Serverless', () => {
      delete process.env.AWS_LAMBDA_FUNCTION_NAME
      delete process.env.K_SERVICE
      delete process.env.FUNCTIONS_WORKER_RUNTIME
      process.env.VERCEL = '1'
      const storage = new PersistentStorage()
      storage.configure()
      const valid = storage.directory.startsWith(join(tmpdir(), 'telemetry-sdk', 'events')) ||
                    storage.directory.startsWith(join(tmpdir(), 'pulse-sdk', 'events'))
      assert.ok(valid, `Storage directory ${storage.directory} should be in tmpdir`)
    })
  })

  describe('Graceful Degradation on Inaccessible / Read-Only Filesystems', () => {
    it('gracefully degrades to in-memory mode when directory is unwritable', async () => {
      const storage = new PersistentStorage()
      // Provide an invalid directory path that cannot be created
      const impossibleDir = process.platform === 'win32'
        ? 'Z:\\non-existent-drive-99999\\pulse-events'
        : '/root/forbidden/pulse-events'

      storage.configure({ directory: impossibleDir })
      const replayed = await storage.init()

      assert.deepEqual(replayed, [])
      assert.equal(storage.isInitialized, false)

      // Operations should be safe no-ops
      storage.persist({
        type: 'error',
        eventId: 'test-event-1',
        timestamp: Date.now(),
      } as any)
      storage.persistBatch([{
        type: 'error',
        eventId: 'test-event-2',
        timestamp: Date.now(),
      } as any])

      await storage.flush()
      await storage.shutdown()
      assert.equal(storage.getStats().eventCount, 0)
    })

    it('honors enabled: false and completely bypasses disk initialization', async () => {
      const storage = new PersistentStorage()
      storage.configure({ enabled: false, directory: join(tmpdir(), 'pulse-should-not-exist') })

      const replayed = await storage.init()
      assert.deepEqual(replayed, [])
      assert.equal(storage.isInitialized, false)

      storage.persist({ type: 'error', eventId: 'e-1', timestamp: Date.now() } as any)
      await storage.flush()
      await storage.shutdown()
      assert.equal(storage.getStats().eventCount, 0)
    })
  })

  describe('SDK Initialization with offlineQueue Options', () => {
    it('allows offlineQueue: false in pulse.init() and skips disk storage', async () => {
      const originalFetch = globalThis.fetch
      globalThis.fetch = async () => new Response(JSON.stringify({
        success: true,
        projectId: TEST_REMOTE_CONFIG.sdk.projectId,
        environment: TEST_REMOTE_CONFIG.sdk.environment,
        release: TEST_REMOTE_CONFIG.sdk.release,
        config: TEST_REMOTE_CONFIG,
      }), { headers: { 'content-type': 'application/json' } })

      try {
        const config = await init({
          apiKey: 'test-api-key-serverless',
          offlineQueue: false,
          initRetries: 0,
        })
        assert.ok(config)
        assert.equal(client.initialized, true)
        assert.equal(persistentStorage.isInitialized, false)

        const health = LynkTrace.getHealth()
        assert.equal(health.persistence.initialized, false)
      } finally {
        globalThis.fetch = originalFetch
      }
    })

    it('allows custom offlineQueue directory and limits in pulse.init()', async () => {
      const customDir = join(tmpdir(), `pulse-custom-${Date.now()}`)
      const originalFetch = globalThis.fetch
      globalThis.fetch = async () => new Response(JSON.stringify({
        success: true,
        projectId: TEST_REMOTE_CONFIG.sdk.projectId,
        environment: TEST_REMOTE_CONFIG.sdk.environment,
        release: TEST_REMOTE_CONFIG.sdk.release,
        config: TEST_REMOTE_CONFIG,
      }), { headers: { 'content-type': 'application/json' } })

      try {
        const config = await init({
          apiKey: 'test-api-key-custom-queue',
          offlineQueue: {
            enabled: true,
            directory: customDir,
            maxEvents: 500,
          },
          initRetries: 0,
        })
        assert.ok(config)
        assert.equal(client.initialized, true)
        assert.equal(persistentStorage.isInitialized, true)

        assert.equal(persistentStorage.directory, customDir)
      } finally {
        globalThis.fetch = originalFetch
        try {
          if (existsSync(customDir)) rmSync(customDir, { recursive: true, force: true })
        } catch {}
      }
    })
  })

  describe('wrapHandler Serverless Execution Helper', () => {
    it('sets callbackWaitsForEmptyEventLoop to false on AWS Lambda context', async () => {
      const mockContext: { callbackWaitsForEmptyEventLoop?: boolean } = {
        callbackWaitsForEmptyEventLoop: true,
      }

      const handler = wrapHandler(async (event: any, context: any) => {
        return { statusCode: 200, body: 'ok' }
      })

      const response = await handler({ path: '/test' }, mockContext)
      assert.equal(mockContext.callbackWaitsForEmptyEventLoop, false)
      assert.deepEqual(response, { statusCode: 200, body: 'ok' })
    })

    it('captures unhandled handler error, flushes, and transparently rethrows', async () => {
      const expectedError = new Error('Database connection failed in Lambda')
      const mockContext = {}

      const handler = wrapHandler(async () => {
        throw expectedError
      }, { flushTimeoutMs: 100 })

      await assert.rejects(
        async () => {
          await handler({}, mockContext)
        },
        (err: Error) => {
          assert.equal(err.message, 'Database connection failed in Lambda')
          return true
        }
      )
    })

    it('completes normally when handler returns a synchronous value', async () => {
      const handler = wrapHandler((event: { a: number }) => {
        return event.a * 2
      }, { flushTimeoutMs: 50 })

      const result = await handler({ a: 21 }, {})
      assert.equal(result, 42)
    })

    it('does not stall when flush times out', async () => {
      const handler = wrapHandler(async () => {
        return 'success'
      }, { flushTimeoutMs: 10 }) // very short timeout

      const result = await handler({}, {})
      assert.equal(result, 'success')
    })

    it('BUG-04: flushes active traces and metrics when wrapHandler completes', async () => {
      const originalFetch = globalThis.fetch
      globalThis.fetch = async () => new Response('{}', { status: 200 })
      try {
        const handler = wrapHandler(async () => {
          return { status: 'handled' }
        }, { flushTimeoutMs: 300 })

        const result = await handler({}, {})
        assert.deepEqual(result, { status: 'handled' })
      } finally {
        globalThis.fetch = originalFetch
      }
    })
  })
})
