/**
 * Unit tests for the remote-config validator.
 *
 * The validator is the SDK's last line of defense against a misbehaving
 * control plane. These tests exercise every failure mode that Phase 4
 * promises to catch — null/array payloads, missing sections, wrong-typed
 * fields, oversized schemaVersion, malformed transport routes.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateRemoteConfig } from '../../src/core/config-validator.js'

const validBase = {
  schemaVersion: 1,
  sdk: { projectId: 'p_test', environment: 'production' },
  features: {
    tracing: true, requestCapture: true, errors: true, metrics: true,
    logging: true, profiling: false, crons: false, sessionReplay: false,
    runtimeMetrics: false, eventLoopMonitoring: false, gcMonitoring: false,
  },
  sampling: { traces: 0.1, requests: 1, errors: 1, profiles: 0.01, replays: 0, routes: {} },
  instrumentation: {
    http: true, https: true, fetch: true, axios: true,
    fastify: { enabled: true, captureHooks: true, captureValidationErrors: true },
    express: { enabled: true },
    graphql: { enabled: false, captureResolvers: false },
    prisma: { enabled: false, captureQueries: false, captureParams: false },
    mongodb: false, redis: false, bullmq: false,
  },
  privacy: {
    capture: { headers: false, body: false, response: false, query: false, cookies: false },
    scrubbing: { enabled: true, headers: ['authorization'], fields: ['password'] },
    piiDetection: { enabled: true, maskEmails: true, maskPhones: true, maskIPs: false },
  },
  limits: {
    maxSpansPerTrace: 500, maxSpanAttributes: 100, maxAttributeLength: 2048,
    maxPayloadSize: 262144, maxQueueSize: 10000, maxMemoryMb: 256, maxCpuOverheadPercent: 5,
  },
  killswitches: {
    disableSDK: false, disableTracing: false, disableMetrics: false,
    disableTransport: false, disableProfiling: false, disableErrors: false, disableLogs: false,
  },
  transport: {
    retry: { enabled: true, maxRetries: 3, backoff: 'exponential', baseDelayMs: 500 },
    queue: { overflowStrategy: 'drop_oldest' },
    keepAlive: true,
    routes: {
      traces: { url: 'https://t.example/v1', batchSize: 100, flushIntervalMs: 5000, timeoutMs: 5000, compression: 'gzip' },
      requests: { url: 'https://r.example/v1', batchSize: 200, flushIntervalMs: 2000, timeoutMs: 3000, compression: 'gzip' },
      spans: { url: 'https://s.example/v1', batchSize: 100, flushIntervalMs: 5000, timeoutMs: 5000, compression: 'gzip' },
      errors: { url: 'https://e.example/v1', batchSize: 10, flushIntervalMs: 1000, timeoutMs: 3000, compression: 'gzip' },
      metrics: { url: 'https://m.example/v1', batchSize: 100, flushIntervalMs: 10000, timeoutMs: 5000, compression: 'gzip' },
      logs: { url: 'https://l.example/v1', batchSize: 50, flushIntervalMs: 10000, timeoutMs: 5000, compression: 'gzip' },
      profiles: { url: 'https://p.example/v1', batchSize: 5, flushIntervalMs: 30000, timeoutMs: 15000, compression: 'gzip' },
      events: { url: 'https://ev.example/v1', batchSize: 50, flushIntervalMs: 5000, timeoutMs: 5000, compression: 'gzip' },
      crons: { url: 'https://c.example/v1', batchSize: 1, flushIntervalMs: 0, timeoutMs: 5000, compression: 'none' },
      replays: { url: 'https://rp.example/v1', batchSize: 1, flushIntervalMs: 5000, timeoutMs: 30000, compression: 'gzip' },
    },
  },
  runtime: { configTtlSeconds: 300, staleWhileRevalidate: true },
  meta: { generatedAt: '2026-05-25T10:00:00Z', generatedBy: 'pulse-control-plane' },
}

test('valid config passes', () => {
  const result = validateRemoteConfig(validBase)
  assert.equal(result.valid, true, `expected valid, got errors: ${result.errors.join(', ')}`)
})

test('null payload is rejected', () => {
  const result = validateRemoteConfig(null)
  assert.equal(result.valid, false)
  assert.match(result.errors.join(' '), /not a JSON object/)
})

test('array payload is rejected', () => {
  const result = validateRemoteConfig([1, 2, 3])
  assert.equal(result.valid, false)
})

test('string payload is rejected', () => {
  const result = validateRemoteConfig('hello')
  assert.equal(result.valid, false)
})

test('missing schemaVersion is rejected', () => {
  const { schemaVersion: _v, ...bad } = validBase
  const result = validateRemoteConfig(bad)
  assert.equal(result.valid, false)
  assert.match(result.errors.join(' '), /schemaVersion/)
})

test('schemaVersion newer than SDK is rejected', () => {
  const result = validateRemoteConfig({ ...validBase, schemaVersion: 99 })
  assert.equal(result.valid, false)
  assert.match(result.errors.join(' '), /upgrade required/)
})

test('missing top-level section is rejected', () => {
  const { features: _f, ...bad } = validBase
  const result = validateRemoteConfig(bad)
  assert.equal(result.valid, false)
  assert.match(result.errors.join(' '), /features/)
})

test('non-boolean feature value is rejected', () => {
  const bad = { ...validBase, features: { ...validBase.features, tracing: 1 as unknown as boolean } }
  const result = validateRemoteConfig(bad)
  assert.equal(result.valid, false)
  assert.match(result.errors.join(' '), /features\.tracing.*boolean/)
})

test('non-boolean killswitch value is rejected', () => {
  const bad = { ...validBase, killswitches: { ...validBase.killswitches, disableSDK: 'true' as unknown as boolean } }
  const result = validateRemoteConfig(bad)
  assert.equal(result.valid, false)
  assert.match(result.errors.join(' '), /killswitches\.disableSDK/)
})

test('out-of-range sampling rate is rejected', () => {
  const bad = { ...validBase, sampling: { ...validBase.sampling, traces: 1.5 } }
  const result = validateRemoteConfig(bad)
  assert.equal(result.valid, false)
  assert.match(result.errors.join(' '), /sampling\.traces/)
})

test('missing transport route URL is rejected', () => {
  const bad = {
    ...validBase,
    transport: {
      ...validBase.transport,
      routes: {
        ...validBase.transport.routes,
        errors: { ...validBase.transport.routes.errors, url: '' },
      },
    },
  }
  const result = validateRemoteConfig(bad)
  assert.equal(result.valid, false)
  assert.match(result.errors.join(' '), /transport\.routes\.errors\.url/)
})

test('missing sdk.projectId is rejected', () => {
  const bad = { ...validBase, sdk: { projectId: '', environment: 'production' } }
  const result = validateRemoteConfig(bad)
  assert.equal(result.valid, false)
  assert.match(result.errors.join(' '), /projectId/)
})

test('extra unknown top-level fields are tolerated (forward compat)', () => {
  const result = validateRemoteConfig({ ...validBase, futureField: 'something' })
  assert.equal(result.valid, true)
})
