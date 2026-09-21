import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { TEST_REMOTE_CONFIG as BAKED_IN_REMOTE_CONFIG } from '../fixtures/remote-config.js'
import { ConfigApplier } from '../../src/core/config-applier.js'
import { ConfigManager } from '../../src/core/config-manager.js'
import { RemoteConfigClient } from '../../src/core/remote-config-client.js'
import type { RemoteConfigResponse } from '../../src/types/config.js'

function config(traceRate = 0.25, generatedAt = '2026-07-30T00:00:00.000Z'): RemoteConfigResponse {
  const routes = Object.fromEntries(
    Object.entries(BAKED_IN_REMOTE_CONFIG.transport.routes).map(([name, route]) => [
      name,
      { ...route, url: `https://ingest.example.test/v1/${name}` },
    ]),
  ) as RemoteConfigResponse['transport']['routes']

  return {
    ...BAKED_IN_REMOTE_CONFIG,
    sdk: { projectId: 'project-1', service: 'orders', environment: 'production', release: '1.0.0' },
    sampling: { ...BAKED_IN_REMOTE_CONFIG.sampling, traces: traceRate },
    transport: { ...BAKED_IN_REMOTE_CONFIG.transport, routes },
    meta: { generatedAt, generatedBy: 'test-control-plane' },
    entitlements: { ...BAKED_IN_REMOTE_CONFIG.entitlements! },
  }
}

function response(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

afterEach(() => ConfigManager.reset())

function initPayload(snapshot: RemoteConfigResponse) {
  return {
    success: true,
    projectId: snapshot.sdk.projectId,
    environment: snapshot.sdk.environment,
    release: snapshot.sdk.release,
    config: snapshot,
  }
}


describe('single-source remote configuration runtime', () => {
  it('bounds startup even when fetch ignores cancellation, without retrying', async () => {
    let calls = 0
    let signal: AbortSignal | null | undefined
    const remote = new RemoteConfigClient({
      apiKey: 'key',
      initTimeoutMs: 20,
      initRetries: 0,
      fetchImpl: async (_input, options) => {
        calls++
        signal = options?.signal
        return new Promise<Response>(() => {})
      },
    })
    await assert.rejects(remote.initialize(), /timed out/)
    assert.equal(calls, 1)
    assert.equal(signal?.aborted, true)
  })

  it('includes a stalled response body in the startup deadline', async () => {
    const remote = new RemoteConfigClient({
      apiKey: 'key',
      initTimeoutMs: 20,
      fetchImpl: async () => ({ text: () => new Promise<string>(() => {}) }) as Response,
    })
    await assert.rejects(remote.initialize(), /timed out/)
  })

  it('retries one transient init response and returns the validated snapshot', async () => {
    let calls = 0
    const snapshot = config()
    const remote = new RemoteConfigClient({
      apiKey: 'key',
      initTimeoutMs: 500,
      fetchImpl: async () => {
        calls++
        return calls === 1
          ? response({ error: 'temporarily unavailable' }, 503)
          : response(initPayload(snapshot))
      },
    })

    const result = await remote.initialize()
    assert.equal(calls, 2)
    assert.equal(result.config.sdk.projectId, snapshot.sdk.projectId)
  })

  it('does not retry permanent init failures', async () => {
    let calls = 0
    const remote = new RemoteConfigClient({
      apiKey: 'key',
      fetchImpl: async () => {
        calls++
        return response({ error: 'invalid API key' }, 401)
      },
    })

    await assert.rejects(remote.initialize(), /Control-plane request failed/)
    assert.equal(calls, 1)
  })

  it('does not wait past the startup deadline for a Retry-After response', async () => {
    let calls = 0
    const remote = new RemoteConfigClient({
      apiKey: 'key',
      initTimeoutMs: 100,
      fetchImpl: async () => {
        calls++
        return new Response(JSON.stringify({ error: 'rate limited' }), {
          status: 429,
          headers: { 'retry-after': '1' },
        })
      },
    })

    const startedAt = performance.now()
    await assert.rejects(remote.initialize(), /Control-plane request failed/)
    assert.ok(performance.now() - startedAt < 100, 'Retry-After must not extend init timeout')
    assert.equal(calls, 1)
  })

  it('keeps retries within the configured total startup deadline', async () => {
    let calls = 0
    const remote = new RemoteConfigClient({
      apiKey: 'key',
      initTimeoutMs: 100,
      fetchImpl: async () => {
        calls++
        return new Promise<Response>(() => {})
      },
    })
    const startedAt = performance.now()
    await assert.rejects(remote.initialize(), /timed out/)
    const elapsedMs = performance.now() - startedAt

    assert.ok(calls >= 1 && calls <= 2, `expected one bounded retry sequence, got ${calls} attempts`)
    assert.ok(elapsedMs < 180, `init retry exceeded its 100ms deadline: ${elapsedMs}ms`)
  })

  it('performs one header-auth /v1/init request and no startup config request', async () => {
    const calls: Array<{ url: string; body: unknown; headers: HeadersInit | undefined }> = []
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({
        url: String(input),
        body: JSON.parse(String(init?.body)),
        headers: init?.headers,
      })
      return response(initPayload(config()))
    }

    const remote = new RemoteConfigClient({ apiKey: 'secret-key', fetchImpl })
    const initResponse = await remote.initialize()
    ConfigManager.getInstance().initialize(remote, initResponse.config)

    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.url, 'http://127.0.0.1:5000/v1/init')
    assert.deepEqual(calls[0]?.body, {})
    assert.equal((calls[0]?.headers as Record<string, string> | undefined)?.['X-API-Key'], 'secret-key')
  })

  it('rejects missing or inconsistent /v1/init identity metadata', async () => {
    const snapshot = config()
    const invalidPayloads = [
      { success: true, environment: snapshot.sdk.environment, release: snapshot.sdk.release, config: snapshot },
      { success: true, projectId: snapshot.sdk.projectId, environment: '   ', release: snapshot.sdk.release, config: snapshot },
      { success: true, projectId: snapshot.sdk.projectId, environment: snapshot.sdk.environment, release: '', config: snapshot },
      { success: true, projectId: 'different-project', environment: snapshot.sdk.environment, release: snapshot.sdk.release, config: snapshot },
      { success: true, projectId: snapshot.sdk.projectId, environment: 'different-environment', release: snapshot.sdk.release, config: snapshot },
      { success: true, projectId: snapshot.sdk.projectId, environment: snapshot.sdk.environment, release: 'different-release', config: snapshot },
    ]

    for (const payload of invalidPayloads) {
      const remote = new RemoteConfigClient({
        apiKey: 'key',
        fetchImpl: async () => response(payload),
      })
      await assert.rejects(() => remote.initialize(), /Init response/)
    }
  })

  it('does nothing for change:false and refreshes once for concurrent change:true signals', async () => {
    let sdkConfigCalls = 0
    let releaseRefresh!: () => void
    const refreshGate = new Promise<void>(resolve => { releaseRefresh = resolve })
    const fetchImpl: typeof fetch = async input => {
      const url = String(input)
      if (url.endsWith('/v1/init')) {
        return response(initPayload(config(0.25)))
      }
      sdkConfigCalls++
      await refreshGate
      return response(config(0.75, '2026-07-30T00:01:00.000Z'))
    }

    const remote = new RemoteConfigClient({ apiKey: 'key', fetchImpl })
    const initial = await remote.initialize()
    const manager = ConfigManager.getInstance()
    manager.initialize(remote, initial.config)

    manager.handleTelemetryResponse(202, { status: 202, change: false })
    manager.handleTelemetryResponse(500, { status: 202, change: true })
    manager.handleTelemetryResponse(200, { status: 201, change: true })
    assert.equal(sdkConfigCalls, 0)

    manager.handleTelemetryResponse(202, { status: 202, change: true })
    manager.handleTelemetryResponse(202, { status: 202, change: true })
    manager.handleTelemetryResponse(202, { status: 202, change: true })
    assert.equal(sdkConfigCalls, 1)

    releaseRefresh()
    await manager.waitForRefresh()
    assert.equal(manager.getConfig().sampling.traces, 0.75)
  })

  it('atomically freezes a replacement and applies only changed sections', async () => {
    const next = config(0.9, '2026-07-30T00:02:00.000Z')
    const fetchImpl: typeof fetch = async input => String(input).endsWith('/v1/init')
      ? response(initPayload(config(0.1)))
      : response(next)

    const remote = new RemoteConfigClient({ apiKey: 'key', fetchImpl })
    const initial = await remote.initialize()
    const manager = ConfigManager.getInstance()
    const before = manager.initialize(remote, initial.config)
    const applied: string[] = []
    manager.setApplier(new ConfigApplier({
      sampling: () => { applied.push('sampling') },
      transport: () => { applied.push('transport') },
      features: () => { applied.push('features') },
    }))

    manager.handleTelemetryResponse(200, { status: 202, change: true })
    await manager.waitForRefresh()

    const after = manager.getConfig()
    assert.notEqual(after, before)
    assert.equal(after.sampling.traces, 0.9)
    assert.equal(Object.isFrozen(after), true)
    assert.equal(Object.isFrozen(after.sampling), true)
    assert.deepEqual(applied, ['sampling'])
  })

  it('retains the last valid config after failure and waits for another signal before retrying', async () => {
    let refreshAttempts = 0
    const fetchImpl: typeof fetch = async input => {
      if (String(input).endsWith('/v1/init')) return response(initPayload(config(0.2)))
      refreshAttempts++
      if (refreshAttempts === 1) return response({ error: true }, 500)
      return response(config(0.8, '2026-07-30T00:03:00.000Z'))
    }

    const remote = new RemoteConfigClient({ apiKey: 'key', fetchImpl })
    const initial = await remote.initialize()
    const manager = ConfigManager.getInstance()
    const original = manager.initialize(remote, initial.config)

    manager.handleTelemetryResponse(202, { status: 202, change: true })
    await manager.waitForRefresh()
    assert.equal(refreshAttempts, 1)
    assert.equal(manager.getConfig(), original)

    // No timer/retry loop: yielding does not produce another request.
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(refreshAttempts, 1)

    manager.handleTelemetryResponse(202, { status: 202, change: true })
    await manager.waitForRefresh()
    assert.equal(refreshAttempts, 2)
    assert.equal(manager.getConfig().sampling.traces, 0.8)
  })
})
