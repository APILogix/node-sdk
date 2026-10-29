import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { validateRemoteConfig, normalizeRemoteConfig } from '../../src/core/config-validator.js'
import { RemoteConfigClient } from '../../src/core/remote-config-client.js'
import { ConfigManager } from '../../src/core/config-manager.js'
import { diffConfigs } from '../../src/core/config-differ.js'
import { isNormalizedRemoteConfig, sdkInitOptionsSchema } from '../../src/types/config.js'
import { EntitlementGate } from '../../src/core/entitlement-gate.js'
import { registerAutoInstrumentations, resetAutoInstrumentations } from '../../src/instrumentation/auto-instrument.js'

afterEach(() => {
  resetAutoInstrumentations()
  ConfigManager.reset()
  EntitlementGate.reset()
})

const PROPOSED_REMOTE_CONFIG = {
  sdk: {
    release: '1.0.0',
    configRevision: 1,
    projectId: '1eebfd8f-555d-4cac-92de-df802a3a138e',
    environment: 'production',
  },
  meta: {
    configHash: '83905b8e0b051f11778b992b221c032590b93473f566805ec43baa054f705142',
    generatedAt: '2026-10-24T16:01:06.872Z',
    generatedBy: 'pulse-config-compiler@1',
  },
  limits: {
    maxMemoryMb: 'auto',
    maxQueueSize: 100000,
    maxPayloadSize: 4194304,
    maxSpansPerTrace: 5000,
    tenantGovernance: {
      enabled: false,
      quotaPerWindow: 10000,
      criticalReserve: 100,
      windowDurationMs: 60000,
      maxTenantsTracked: 1000,
    },
    maxSpanAttributes: 200,
    maxAttributeLength: 8192,
    persistenceGovernance: {
      adaptive: true,
      maxPersistPerMinute: 100000,
      budgetExceededLogIntervalMs: 60000,
    },
  },
  privacy: {
    capture: {
      body: false,
      query: false,
      cookies: false,
      headers: false,
      response: false,
    },
    scrubbing: {
      fields: [
        'password', 'secret', 'token', 'apiKey', 'authorization',
        'creditCard', 'ssn', 'access_token', 'refresh_token', 'client_secret',
      ],
      enabled: true,
      headers: [
        'authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'x-api-key',
      ],
    },
    piiDetection: {
      enabled: true,
      maskIPs: true,
      maskEmails: true,
      maskPhones: true,
    },
  },
  runtime: {
    configTtlSeconds: 300,
    staleWhileRevalidate: true,
  },
  features: {
    crons: true,
    errors: true,
    logging: true,
    metrics: true,
    tracing: true,
    profiling: true,
    gcMonitoring: true,
    requestCapture: true,
    runtimeMetrics: true,
    eventLoopMonitoring: true,
  },
  sampling: {
    logs: 1,
    crons: 1,
    spans: 1,
    errors: 1,
    events: 1,
    routes: {},
    traces: 1,
    metrics: 1,
    messages: 1,
    profiles: 1,
    requests: 1,
  },
  transport: {
    queue: {
      maxSize: 100000,
      criticalReserve: 10000,
      overflowStrategy: 'drop_oldest' as const,
    },
    retry: {
      backoff: 'exponential' as const,
      enabled: true,
      maxRetries: 3,
      baseDelayMs: 500,
    },
    routes: {
      logs: {
        url: 'http://localhost:5000/api/v1/logs',
        priority: 'normal' as const,
        batchSize: 200,
        timeoutMs: 5000,
        flushIntervalMs: 10000,
      },
      crons: {
        url: 'http://localhost:5000/api/v1/checkins',
        priority: 'high' as const,
        batchSize: 1,
        timeoutMs: 5000,
        flushIntervalMs: 0,
      },
      spans: {
        url: 'http://localhost:5000/api/v1/spans',
        priority: 'normal' as const,
        batchSize: 500,
        timeoutMs: 5000,
        flushIntervalMs: 5000,
      },
      errors: {
        url: 'http://localhost:5000/api/v1/errors',
        priority: 'critical' as const,
        batchSize: 100,
        timeoutMs: 5000,
        flushIntervalMs: 1000,
      },
      events: {
        url: 'http://localhost:5000/api/v1/events',
        priority: 'high' as const,
        batchSize: 100,
        timeoutMs: 5000,
        flushIntervalMs: 2000,
      },
      traces: {
        url: 'http://localhost:5000/api/v1/traces',
        priority: 'high' as const,
        batchSize: 500,
        timeoutMs: 5000,
        flushIntervalMs: 5000,
      },
      metrics: {
        url: 'http://localhost:5000/api/v1/metrics',
        priority: 'normal' as const,
        batchSize: 1000,
        timeoutMs: 5000,
        flushIntervalMs: 10000,
      },
      profiles: {
        url: 'http://localhost:5000/api/v1/profiles',
        priority: 'low' as const,
        batchSize: 5,
        timeoutMs: 15000,
        flushIntervalMs: 30000,
      },
      requests: {
        url: 'http://localhost:5000/api/v1/requests',
        priority: 'high' as const,
        batchSize: 500,
        timeoutMs: 5000,
        flushIntervalMs: 5000,
      },
    },
    keepAlive: true,
    connections: {
      acquireTimeoutMs: 5000,
      maxTotalConnections: 100,
    },
  },
  entitlements: {
    crons: true,
    errors: true,
    logging: true,
    metrics: true,
    tracing: true,
    profiling: true,
    customSpans: true,
    customMetrics: true,
    requestCapture: true,
  },
  killswitches: {
    disableSDK: false,
    disableLogs: false,
    disableErrors: false,
    disableMetrics: false,
    disableTracing: false,
    disableProfiling: false,
    disableTransport: false,
  },
  instrumentation: true,
}

describe('Simplified Remote Configuration (v3.2.0)', () => {
  it('validates proposed configuration without schemaVersion and with instrumentation: true', () => {
    const res = validateRemoteConfig(PROPOSED_REMOTE_CONFIG)
    assert.equal(res.valid, true, `Validation errors: ${res.errors.join(', ')}`)
  })

  it('normalizes proposed config by defaulting schemaVersion to 1 and copying configRevision to meta', () => {
    const normalized = normalizeRemoteConfig(PROPOSED_REMOTE_CONFIG)
    assert.equal(normalized.schemaVersion, 1)
    assert.equal(normalized.sdk.projectId, '1eebfd8f-555d-4cac-92de-df802a3a138e')
    assert.equal(normalized.sdk.service, '1eebfd8f-555d-4cac-92de-df802a3a138e')
    assert.equal(normalized.sdk.configRevision, 1)
    assert.equal(normalized.meta.configRevision, 1)
    assert.equal(normalized.instrumentation, true)
    assert.equal(isNormalizedRemoteConfig(normalized), true)
  })

  it('supports config.sdk.configversion (lowercase) gracefully', () => {
    const variant = {
      ...PROPOSED_REMOTE_CONFIG,
      sdk: {
        release: '1.0.0',
        configversion: 42,
        projectId: '1eebfd8f-555d-4cac-92de-df802a3a138e',
        environment: 'production',
      },
    }
    const res = validateRemoteConfig(variant)
    assert.equal(res.valid, true)
    const normalized = normalizeRemoteConfig(variant)
    assert.equal(normalized.sdk.configRevision, 42)
    assert.equal(normalized.meta.configRevision, 42)
  })

  it('allows RemoteConfigClient to initialize when root envelope identity is omitted', async () => {
    const wireResponse = {
      success: true,
      config: PROPOSED_REMOTE_CONFIG,
      requestId: '01a16eac-6cc4-7435-92e8-4616b04bb518',
    }

    const client = new RemoteConfigClient({
      apiKey: 'test-api-key-1234567890abcdef',
      initTimeoutMs: 1000,
      fetchImpl: async () => new Response(JSON.stringify(wireResponse), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    })

    const init = await client.initialize()
    assert.equal(init.success, true)
    assert.equal(init.projectId, '1eebfd8f-555d-4cac-92de-df802a3a138e')
    assert.equal(init.environment, 'production')
    assert.equal(init.release, '1.0.0')
    assert.equal(init.configRevision, 1)
  })

  it('accepts polymorphic instrumentation: { enabled: true, disabled: ["redis", "bullmq"] }', () => {
    const configWithExclusions = {
      ...PROPOSED_REMOTE_CONFIG,
      instrumentation: {
        enabled: true,
        disabled: ['redis', 'bullmq'],
      },
    }
    const res = validateRemoteConfig(configWithExclusions)
    assert.equal(res.valid, true, `Errors: ${res.errors.join(', ')}`)
  })

  it('diffs transitions between boolean instrumentation and object instrumentation safely', () => {
    const configA = normalizeRemoteConfig(PROPOSED_REMOTE_CONFIG)
    const configB = normalizeRemoteConfig({
      ...PROPOSED_REMOTE_CONFIG,
      instrumentation: {
        enabled: true,
        disabled: ['redis'],
      },
    })

    const diff = diffConfigs(configA, configB)
    assert.equal(diff.instrumentationChanged, true)
    assert.equal(diff.tracingChanged, true)
  })

  it('activates all instrumentations when instrumentation: true', () => {
    const config = normalizeRemoteConfig(PROPOSED_REMOTE_CONFIG)
    const client = new RemoteConfigClient({ apiKey: 'test-api-key-1234567890abcdef' })
    ConfigManager.getInstance().initialize(client, config)
    EntitlementGate.initialize(config.entitlements)

    registerAutoInstrumentations()
    const registry = (globalThis as any)[Symbol.for('lynktrace.auto-instrumentation.registry')]
    assert.ok(registry, 'Registry should be initialized')
    assert.ok(registry.http, 'HTTP instrumentation should be active')
    assert.ok(registry.express, 'Express instrumentation should be active')
    assert.ok(registry.pg, 'Postgres instrumentation should be active')
    assert.ok(registry.redis, 'Redis instrumentation should be active')
    assert.ok(registry.bullmq, 'BullMQ instrumentation should be active')
    assert.ok(registry.mysql2, 'MySQL2 instrumentation should be active')
    assert.ok(registry.mongodb, 'MongoDB instrumentation should be active')
    assert.ok(registry.prisma, 'Prisma instrumentation should be active')
  })

  it('deactivates all instrumentations when instrumentation: false', () => {
    const config = normalizeRemoteConfig({
      ...PROPOSED_REMOTE_CONFIG,
      instrumentation: false,
    })
    const client = new RemoteConfigClient({ apiKey: 'test-api-key-1234567890abcdef' })
    ConfigManager.getInstance().initialize(client, config)
    EntitlementGate.initialize(config.entitlements)

    registerAutoInstrumentations()
    const registry = (globalThis as any)[Symbol.for('lynktrace.auto-instrumentation.registry')]
    assert.ok(registry, 'Registry should be present')
    assert.equal(registry.http, undefined)
    assert.equal(registry.express, undefined)
    assert.equal(registry.pg, undefined)
    assert.equal(registry.redis, undefined)
    assert.equal(registry.bullmq, undefined)
  })

  it('selectively excludes disabled libraries with { enabled: true, disabled: ["redis", "bullmq"] }', () => {
    const config = normalizeRemoteConfig({
      ...PROPOSED_REMOTE_CONFIG,
      instrumentation: {
        enabled: true,
        disabled: ['redis', 'bullmq'],
      },
    })
    const client = new RemoteConfigClient({ apiKey: 'test-api-key-1234567890abcdef' })
    ConfigManager.getInstance().initialize(client, config)
    EntitlementGate.initialize(config.entitlements)

    registerAutoInstrumentations()
    const registry = (globalThis as any)[Symbol.for('lynktrace.auto-instrumentation.registry')]
    assert.ok(registry, 'Registry should be initialized')
    assert.ok(registry.http, 'HTTP should remain active')
    assert.ok(registry.pg, 'PG should remain active')
    assert.equal(registry.redis, undefined, 'Redis should be disabled')
    assert.equal(registry.bullmq, undefined, 'BullMQ should be disabled')
  })

  it('validates remote config without sessionReplay in features or entitlements', () => {
    assert.equal((PROPOSED_REMOTE_CONFIG.features as any).sessionReplay, undefined)
    assert.equal((PROPOSED_REMOTE_CONFIG.entitlements as any).sessionReplay, undefined)

    const result = validateRemoteConfig(PROPOSED_REMOTE_CONFIG)
    assert.equal(result.valid, true, `Validation errors: ${result.errors.join(', ')}`)

    const normalized = normalizeRemoteConfig(PROPOSED_REMOTE_CONFIG)
    assert.equal(normalized.features.tracing, true)
    assert.equal(normalized.features.profiling, true)
    assert.equal((normalized.features as any).sessionReplay, undefined)
    assert.equal((normalized.entitlements as any).sessionReplay, undefined)
  })

  it('strictly enforces that init() options do not have projectId, environment, or release', () => {
    // SDKInitOptions only requires apiKey; projectId, environment, and release come exclusively from remote config
    const options = {
      apiKey: 'test-api-key-1234567890abcdef',
    }
    const schemaResult = sdkInitOptionsSchema.safeParse(options)
    assert.equal(schemaResult.success, true)

    // Remote-managed policy fields are strictly rejected in init options
    assert.equal(sdkInitOptionsSchema.safeParse({ apiKey: 'key', projectId: 'proj' }).success, false)
    assert.equal(sdkInitOptionsSchema.safeParse({ apiKey: 'key', environment: 'production' }).success, false)
    assert.equal(sdkInitOptionsSchema.safeParse({ apiKey: 'key', release: '1.0.0' }).success, false)
  })
})
