import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ProfilingSubsystem } from '../../src/subsystems/profiling-subsystem.js'
import { EntitlementGate } from '../../src/core/entitlement-gate.js'
import { TEST_REMOTE_CONFIG } from '../fixtures/remote-config.js'
import type { EventMetadata, ProfileEvent } from '../../src/types/event.js'

const TEST_METADATA: EventMetadata = {
  sdkName: 'pulse-node',
  sdkVersion: '0.0.0-test',
  applicationName: 'continuous-profiling-test',
  applicationVersion: '1.0.0',
  projectId: 'test-project',
  environment: 'test',
  release: '1.0.0',
}

function makeRemoteConfig(continuous = true, intervalMs = 60_000, sampleRateHz = 99) {
  return {
    ...TEST_REMOTE_CONFIG,
    features: {
      ...TEST_REMOTE_CONFIG.features,
      profiling: true,
      continuousProfiling: continuous,
    },
    profiling: {
      enabled: true,
      cpu: true,
      heap: true,
      sampleRate: 1,
      maxDurationMs: 30_000,
      continuous,
      continuousIntervalMs: intervalMs,
      sampleRateHz,
    },
    sampling: { ...TEST_REMOTE_CONFIG.sampling, profiles: 1 },
    entitlements: { ...TEST_REMOTE_CONFIG.entitlements, profiling: true },
  }
}

function installMockSession(
  subsystem: ProfilingSubsystem,
  posts: Array<{ method: string; params?: unknown }> = [],
) {
  ;(subsystem as any).inspectorSession = {
    async post(method: string, params?: unknown) {
      posts.push({ method, params })
      if (method === 'Profiler.stop') {
        return {
          profile: {
            nodes: [
              { id: 1, callFrame: { functionName: '(root)', scriptId: '0', url: '', lineNumber: 0, columnNumber: 0 } },
              { id: 2, callFrame: { functionName: 'calculateInvoice', scriptId: '1', url: 'app.js', lineNumber: 42, columnNumber: 5 } },
            ],
            startTime: 1000,
            endTime: 2000,
            samples: [1, 2, 2, 2],
            timeDeltas: [100, 200, 300, 400],
          },
        }
      }
      return {}
    },
    disconnect() {
      posts.push({ method: 'disconnect' })
    },
  }
  ;(subsystem as any).inspectorAvailable = true
}

describe('Continuous Wall-Clock CPU Profiler (Continuous Profiling)', () => {
  afterEach(() => {
    ProfilingSubsystem.reset()
    EntitlementGate.reset()
  })

  it('automatically activates continuous profiling derived purely from remote config', async () => {
    EntitlementGate.initialize({ ...TEST_REMOTE_CONFIG.entitlements, profiling: true })
    const emitted: ProfileEvent[] = []
    const config = makeRemoteConfig(true, 5000, 99)

    const subsystem = ProfilingSubsystem.initialize(config, event => emitted.push(event), TEST_METADATA)
    const posts: Array<{ method: string; params?: unknown }> = []
    installMockSession(subsystem, posts)

    // Start subsystem as done during init()
    await subsystem.start()

    assert.equal(subsystem.isContinuousActive(), true)
    const activeConfig = subsystem.getContinuousConfig()
    assert.equal(activeConfig.continuous, true)
    assert.equal(activeConfig.intervalMs, 5000)
    assert.equal(activeConfig.sampleRateHz, 99)

    // Verify Inspector profiler commands were issued
    const methods = posts.map(p => p.method)
    assert.ok(methods.includes('Profiler.enable'))
    assert.ok(methods.includes('Profiler.setSamplingInterval'))
    assert.ok(methods.includes('Profiler.start'))

    await subsystem.stop()
    assert.equal(subsystem.isContinuousActive(), false)
  })

  it('flushes chunked continuous profile events and correlates active trace IDs', async () => {
    EntitlementGate.initialize({ ...TEST_REMOTE_CONFIG.entitlements, profiling: true })
    const emitted: ProfileEvent[] = []
    const config = makeRemoteConfig(true, 60_000, 99)

    const subsystem = ProfilingSubsystem.initialize(config, event => emitted.push(event), TEST_METADATA)
    const posts: Array<{ method: string; params?: unknown }> = []
    installMockSession(subsystem, posts)

    await subsystem.start()

    // Simulate active traces occurring during this continuous chunk
    subsystem.recordActiveTrace('trace-order-1001')
    subsystem.recordActiveTrace('trace-order-1002')

    // Flush chunk
    await subsystem.flushContinuousChunk()

    assert.equal(emitted.length, 1)
    const event = emitted[0]!
    assert.ok(event)
    assert.equal(event.type, 'profile')
    assert.equal(event.profileType, 'cpu')
    assert.equal(event.isContinuous, true)
    assert.equal(event.sampleRateHz, 99)
    assert.ok(event.duration >= 0)
    assert.ok(event.profile)
    assert.deepEqual(event.activeTraceIds, ['trace-order-1001', 'trace-order-1002'])

    // Verify Profiler.stop followed immediately by Profiler.start for next chunk
    const lastPosts = posts.slice(-2).map(p => p.method)
    assert.deepEqual(lastPosts, ['Profiler.stop', 'Profiler.start'])

    await subsystem.stop()
  })

  it('dynamically adapts to remote config transitions at runtime', async () => {
    EntitlementGate.initialize({ ...TEST_REMOTE_CONFIG.entitlements, profiling: true })
    const emitted: ProfileEvent[] = []

    // Start with continuous profiling DISABLED in remote config
    const initialConfig = makeRemoteConfig(false)
    const subsystem = ProfilingSubsystem.initialize(initialConfig, event => emitted.push(event), TEST_METADATA)
    const posts: Array<{ method: string; params?: unknown }> = []
    installMockSession(subsystem, posts)

    await subsystem.start()
    assert.equal(subsystem.isContinuousActive(), false)

    // Remote config update arrives: control plane enables continuous profiling
    const enabledConfig = makeRemoteConfig(true, 10_000, 99)
    subsystem.handleConfigChange(enabledConfig)
    // Allow async startContinuousProfiling to complete
    await new Promise(resolve => setTimeout(resolve, 10))

    assert.equal(subsystem.isContinuousActive(), true)
    assert.equal(subsystem.getContinuousConfig().intervalMs, 10_000)

    // Remote config update arrives: control plane disables continuous profiling
    const disabledConfig = makeRemoteConfig(false)
    subsystem.handleConfigChange(disabledConfig)

    assert.equal(subsystem.isContinuousActive(), false)
    await subsystem.stop()
  })

  it('fails open without throwing if profiler methods encounter an error', async () => {
    EntitlementGate.initialize({ ...TEST_REMOTE_CONFIG.entitlements, profiling: true })
    const subsystem = ProfilingSubsystem.initialize(makeRemoteConfig(true), () => undefined, TEST_METADATA)

    // Mock failing session
    ;(subsystem as any).inspectorSession = {
      async post(method: string) {
        if (method === 'Profiler.start') throw new Error('V8 Inspector internal error')
        return {}
      },
      disconnect() {},
    }
    ;(subsystem as any).inspectorAvailable = true

    // Must not throw — fail-open runtime guarantee
    const started = await subsystem.startContinuousProfiling()
    assert.equal(started, false)
    assert.equal(subsystem.isContinuousActive(), false)

    await subsystem.stop()
  })

  it('F-04: enforces cooling duty cycle between continuous chunks', async () => {
    EntitlementGate.initialize({ ...TEST_REMOTE_CONFIG.entitlements, profiling: true })
    const emitted: ProfileEvent[] = []
    const baseConfig = makeRemoteConfig(true, 5000, 99)
    const config = {
      ...baseConfig,
      profiling: {
        ...baseConfig.profiling,
        coolingIntervalMs: 50,
      },
    }

    const subsystem = ProfilingSubsystem.initialize(config, event => emitted.push(event), TEST_METADATA)
    const posts: Array<{ method: string; params?: unknown }> = []
    installMockSession(subsystem, posts)

    await subsystem.start()
    assert.equal(subsystem.isContinuousActive(), true)
    assert.equal(subsystem.isContinuousCooling(), false)
    assert.equal(subsystem.getContinuousConfig().coolingIntervalMs, 50)

    // Initial start invoked Profiler.start
    assert.equal(posts[posts.length - 1]?.method, 'Profiler.start')

    // Flush chunk -> must enter cooling mode and NOT immediately start profiler
    await subsystem.flushContinuousChunk()
    assert.equal(emitted.length, 1)
    assert.equal(subsystem.isContinuousCooling(), true)
    // Most recent inspector call must be Profiler.stop (Profiler.start is delayed)
    assert.equal(posts[posts.length - 1]?.method, 'Profiler.stop')

    // Wait for cooling period (50ms) to elapse
    await new Promise(resolve => setTimeout(resolve, 80))

    // After cooling period, profiler should have restarted automatically
    assert.equal(subsystem.isContinuousCooling(), false)
    assert.equal(posts[posts.length - 1]?.method, 'Profiler.start')

    // Test safe shutdown during cooling
    await subsystem.flushContinuousChunk()
    assert.equal(subsystem.isContinuousCooling(), true)
    await subsystem.stop()
    assert.equal(subsystem.isContinuousActive(), false)
    assert.equal(subsystem.isContinuousCooling(), false)
  })
})
