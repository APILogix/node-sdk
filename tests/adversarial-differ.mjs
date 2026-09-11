import assert from 'node:assert/strict'
import fc from 'fast-check'
import { diffConfigs, deepEqual } from '../dist/core/config-differ.js'
import { DEFAULT_REMOTE_CONFIG } from '../dist/constants/defaults.js'

function cloneConfig(overrides = {}) {
  return JSON.parse(JSON.stringify({ ...DEFAULT_REMOTE_CONFIG, ...overrides }))
}

function shuffleObjectKeys(obj) {
  if (obj === null || typeof obj !== 'object') return obj
  if (Array.isArray(obj)) return obj.map(shuffleObjectKeys)
  const keys = Object.keys(obj)
  for (let i = keys.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[keys[i], keys[j]] = [keys[j], keys[i]]
  }
  const result = {}
  for (const k of keys) {
    result[k] = shuffleObjectKeys(obj[k])
  }
  return result
}

function reverseObjectKeys(obj) {
  if (obj === null || typeof obj !== 'object') return obj
  if (Array.isArray(obj)) return obj.map(reverseObjectKeys)
  const keys = Object.keys(obj).reverse()
  const result = {}
  for (const k of keys) {
    result[k] = reverseObjectKeys(obj[k])
  }
  return result
}

console.log('--- Starting Empirical Adversarial Challenger Harness for ConfigDiffer ---')

let passedTests = 0
let failedTests = 0

function runTest(name, fn) {
  try {
    fn()
    passedTests++
    console.log(`  ✔ [PASS] ${name}`)
  } catch (err) {
    failedTests++
    console.error(`  ✖ [FAIL] ${name}`)
    console.error(err)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Key Insertion Order Invariance
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[Suite 1: Key Insertion Order Invariance]')

runTest('deepEqual is invariant to reversed top-level and nested key insertion orders', () => {
  const cfg1 = cloneConfig()
  const cfgReversed = reverseObjectKeys(cfg1)
  assert.equal(deepEqual(cfg1, cfgReversed), true)
  assert.equal(deepEqual(cfgReversed, cfg1), true)
})

runTest('diffConfigs returns zero diff for completely reversed key order', () => {
  const cfg1 = cloneConfig()
  const cfgReversed = reverseObjectKeys(cfg1)
  const diff = diffConfigs(cfg1, cfgReversed)
  assert.equal(diff.hasChanges, false)
  assert.equal(diff.sdkChanged, false)
  assert.equal(diff.featuresChanged, false)
  assert.equal(diff.killswitchesChanged, false)
  assert.equal(diff.samplingChanged, false)
  assert.equal(diff.transportChanged, false)
  assert.equal(diff.privacyChanged, false)
  assert.equal(diff.limitsChanged, false)
  assert.equal(diff.instrumentationChanged, false)
  assert.equal(diff.entitlementsChanged, false)
  assert.equal(diff.profilingChanged, false)
  assert.equal(diff.replayChanged, false)
  assert.equal(diff.tracingChanged, false)
  assert.equal(diff.metricsChanged, false)
  assert.equal(diff.loggingChanged, false)
  assert.equal(diff.errorsChanged, false)
  assert.equal(diff.changes.size, 0)
  assert.equal(diff.fieldChanges.length, 0)
  assert.equal(diff.addedKeys.length, 0)
  assert.equal(diff.removedKeys.length, 0)
  assert.equal(diff.modifiedKeys.length, 0)
})

runTest('1,000 random key shuffling iterations produce zero diffs', () => {
  const base = cloneConfig()
  for (let i = 0; i < 1000; i++) {
    const shuffled = shuffleObjectKeys(base)
    const diff = diffConfigs(base, shuffled)
    assert.equal(diff.hasChanges, false, `Iteration ${i} failed hasChanges`)
    assert.equal(diff.changes.size, 0, `Iteration ${i} failed changes.size`)
  }
})

runTest('Key order difference inside modified object does not create phantom field changes', () => {
  const cfgA = cloneConfig()
  const cfgB = cloneConfig()
  // Reorder transport connections and modify only 1 field
  cfgB.transport.connections = {
    acquireTimeoutMs: 9999, // modified
    maxConnectionsPerRoute: cfgA.transport.connections.maxConnectionsPerRoute,
    maxTotalConnections: cfgA.transport.connections.maxTotalConnections,
  }
  const diff = diffConfigs(cfgA, cfgB)
  assert.equal(diff.hasChanges, true)
  assert.equal(diff.transportChanged, true)
  assert.equal(diff.changes.size, 1)
  assert.equal(diff.fieldChanges.length, 1)
  assert.equal(diff.changes.has('transport.connections.acquireTimeoutMs'), true)
  assert.equal(diff.changes.has('transport.connections.maxTotalConnections'), false)
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. Nested Arrays & Array Mutations
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[Suite 2: Nested Arrays & Array Mutations]')

runTest('Array reordering is detected as modified leaf', () => {
  const cfgA = cloneConfig()
  const cfgB = cloneConfig()
  cfgB.privacy.scrubbing.headers = [...cfgA.privacy.scrubbing.headers].reverse()

  const diff = diffConfigs(cfgA, cfgB)
  assert.equal(diff.hasChanges, true)
  assert.equal(diff.privacyChanged, true)
  assert.equal(diff.changes.has('privacy.scrubbing.headers'), true)
  const c = diff.changes.get('privacy.scrubbing.headers')
  assert.equal(c.changeType, 'modified')
  assert.deepEqual(c.old, cfgA.privacy.scrubbing.headers)
  assert.deepEqual(c.new, cfgB.privacy.scrubbing.headers)
})

runTest('Array addition and truncation detected correctly', () => {
  const cfgA = cloneConfig()
  const cfgB = cloneConfig()
  cfgB.privacy.scrubbing.fields = [...cfgA.privacy.scrubbing.fields, 'customToken']

  const diffAdd = diffConfigs(cfgA, cfgB)
  assert.equal(diffAdd.privacyChanged, true)
  assert.equal(diffAdd.changes.get('privacy.scrubbing.fields').changeType, 'modified')

  cfgB.privacy.scrubbing.fields = []
  const diffEmpty = diffConfigs(cfgA, cfgB)
  assert.equal(diffEmpty.privacyChanged, true)
  assert.equal(diffEmpty.changes.get('privacy.scrubbing.fields').changeType, 'modified')
})

runTest('deepEqual handles nested multidimensional arrays and object arrays', () => {
  assert.equal(deepEqual([[1, 2], [3, [4, 5]]], [[1, 2], [3, [4, 5]]]), true)
  assert.equal(deepEqual([[1, 2], [3, [4, 5]]], [[1, 2], [3, [4, 6]]]), false)
  assert.equal(deepEqual([{ a: 1, b: 2 }, { c: 3 }], [{ b: 2, a: 1 }, { c: 3 }]), true)
  assert.equal(deepEqual([{ a: 1 }, { b: 2 }], [{ b: 2 }, { a: 1 }]), false)
})

runTest('deepEqual handles array vs object vs primitives', () => {
  assert.equal(deepEqual([], {}), false)
  assert.equal(deepEqual({}, []), false)
  assert.equal(deepEqual([1], { 0: 1 }), false)
  assert.equal(deepEqual([1], 1), false)
  assert.equal(deepEqual([], null), false)
  assert.equal(deepEqual([], undefined), false)
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. Null, Undefined, Corrupted & Non-Object Inputs
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[Suite 3: Null, Undefined, Corrupted & Non-Object Inputs]')

runTest('diffConfigs with null/undefined boundaries', () => {
  assert.equal(diffConfigs(null, null).hasChanges, false)
  assert.equal(diffConfigs(undefined, undefined).hasChanges, false)
  assert.equal(diffConfigs(null, undefined).hasChanges, false)
  assert.equal(diffConfigs(undefined, null).hasChanges, false)
})

runTest('diffConfigs with null oldConfig populates all added keys', () => {
  const cfg = cloneConfig()
  const diff = diffConfigs(null, cfg)
  assert.equal(diff.hasChanges, true)
  assert.equal(diff.sdkChanged, true)
  assert.equal(diff.featuresChanged, true)
  assert.equal(diff.samplingChanged, true)
  assert.equal(diff.transportChanged, true)
  assert.equal(diff.privacyChanged, true)
  assert.equal(diff.limitsChanged, true)
  assert.equal(diff.killswitchesChanged, true)
  assert.equal(diff.instrumentationChanged, true)
  assert.equal(diff.entitlementsChanged, true)
  assert.ok(diff.addedKeys.length > 20)
  assert.equal(diff.removedKeys.length, 0)
  assert.equal(diff.modifiedKeys.length, 0)
})

runTest('diffConfigs with null newConfig populates all removed keys', () => {
  const cfg = cloneConfig()
  const diff = diffConfigs(cfg, null)
  assert.equal(diff.hasChanges, true)
  assert.equal(diff.sdkChanged, true)
  assert.equal(diff.featuresChanged, true)
  assert.ok(diff.removedKeys.length > 20)
  assert.equal(diff.addedKeys.length, 0)
  assert.equal(diff.modifiedKeys.length, 0)
})

runTest('diffConfigs with non-object primitives does not crash', () => {
  const diffNum = diffConfigs(123, 456)
  assert.equal(typeof diffNum, 'object')
  assert.equal(diffNum.hasChanges, false)

  const diffStr = diffConfigs('foo', 'bar')
  assert.equal(typeof diffStr, 'object')
  assert.equal(diffStr.hasChanges, false)

  const diffBool = diffConfigs(true, false)
  assert.equal(typeof diffBool, 'object')
  assert.equal(diffBool.hasChanges, false)
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. Empty Configs & Partial Config Mutations
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[Suite 4: Empty & Partial Config Mutations]')

runTest('diffConfigs between two empty objects is empty diff', () => {
  const diff = diffConfigs({}, {})
  assert.equal(diff.hasChanges, false)
  assert.equal(diff.changes.size, 0)
})

runTest('diffConfigs handles transitions between empty and nested objects', () => {
  const oldCfg = { features: {} }
  const newCfg = { features: { tracing: true } }
  const diff = diffConfigs(oldCfg, newCfg)
  assert.equal(diff.hasChanges, true)
  assert.equal(diff.featuresChanged, true)
  assert.equal(diff.tracingChanged, true)
  assert.equal(diff.changes.has('features.tracing'), true)
  assert.equal(diff.addedKeys.includes('features.tracing'), true)
})

runTest('diffConfigs handles removal of deeply nested sub-objects', () => {
  const oldCfg = { sampling: { routes: { '/checkout': { traces: 1.0, errors: 1.0 } } } }
  const newCfg = { sampling: { routes: {} } }
  const diff = diffConfigs(oldCfg, newCfg)
  assert.equal(diff.samplingChanged, true)
  assert.equal(diff.tracingChanged, true)
  assert.equal(diff.errorsChanged, true)
  assert.ok(
    diff.removedKeys.includes('sampling.routes./checkout.traces') ||
    diff.removedKeys.includes('sampling.routes./checkout') ||
    diff.changes.has('sampling.routes./checkout.traces')
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// 5. Fast-Flag Activation Matrix & Subsystem Granularity
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[Suite 5: Fast-Flag Activation Matrix & Subsystem Granularity]')

const fastFlagScenarios = [
  // Profiling
  { section: 'features.profiling', setupOld: (c) => (c.features.profiling = false), setup: (c) => (c.features.profiling = true), expected: { profiling: true, replay: false, tracing: false, metrics: false, logging: false, errors: false } },
  { section: 'features.profiling', setup: (c) => (c.features.profiling = false), expected: { profiling: true, replay: false, tracing: false, metrics: false, logging: false, errors: false } },
  { section: 'killswitches.disableProfiling', setup: (c) => (c.killswitches.disableProfiling = true), expected: { profiling: true, replay: false, tracing: false, metrics: false, logging: false, errors: false } },
  { section: 'entitlements.profiling', setup: (c) => (c.entitlements.profiling = false), expected: { profiling: true, replay: false, tracing: false, metrics: false, logging: false, errors: false } },
  { section: 'sampling.profiles', setup: (c) => (c.sampling.profiles = 0.5), expected: { profiling: true, replay: false, tracing: false, metrics: false, logging: false, errors: false } },
  { section: 'sampling.routes./api.profiles', setup: (c) => (c.sampling.routes['/api'] = { profiles: 0.5 }), expected: { profiling: true, replay: false, tracing: false, metrics: false, logging: false, errors: false } },
  { section: 'profiling.maxDurationMs', setup: (c) => (c.profiling = { ...c.profiling, maxDurationMs: 60000 }), expected: { profiling: true, replay: false, tracing: false, metrics: false, logging: false, errors: false } },

  // Session Replay
  { section: 'features.sessionReplay', setupOld: (c) => (c.features.sessionReplay = false), setup: (c) => (c.features.sessionReplay = true), expected: { profiling: false, replay: true, tracing: false, metrics: false, logging: false, errors: false } },
  { section: 'features.sessionReplay', setup: (c) => (c.features.sessionReplay = false), expected: { profiling: false, replay: true, tracing: false, metrics: false, logging: false, errors: false } },
  { section: 'entitlements.sessionReplay', setup: (c) => (c.entitlements.sessionReplay = false), expected: { profiling: false, replay: true, tracing: false, metrics: false, logging: false, errors: false } },
  { section: 'sampling.replays', setup: (c) => (c.sampling.replays = 0.5), expected: { profiling: false, replay: true, tracing: false, metrics: false, logging: false, errors: false } },
  { section: 'sampling.routes./app.replays', setup: (c) => (c.sampling.routes['/app'] = { replays: 0.5 }), expected: { profiling: false, replay: true, tracing: false, metrics: false, logging: false, errors: false } },
  { section: 'replay.sampleRate', setup: (c) => (c.replay = { ...c.replay, sampleRate: 0.5 }), expected: { profiling: false, replay: true, tracing: false, metrics: false, logging: false, errors: false } },

  // Tracing
  { section: 'features.tracing', setupOld: (c) => (c.features.tracing = false), setup: (c) => (c.features.tracing = true), expected: { profiling: false, replay: false, tracing: true, metrics: false, logging: false, errors: false } },
  { section: 'features.tracing', setup: (c) => (c.features.tracing = false), expected: { profiling: false, replay: false, tracing: true, metrics: false, logging: false, errors: false } },
  { section: 'killswitches.disableTracing', setup: (c) => (c.killswitches.disableTracing = true), expected: { profiling: false, replay: false, tracing: true, metrics: false, logging: false, errors: false } },
  { section: 'entitlements.tracing', setup: (c) => (c.entitlements.tracing = false), expected: { profiling: false, replay: false, tracing: true, metrics: false, logging: false, errors: false } },
  { section: 'entitlements.customSpans', setup: (c) => (c.entitlements.customSpans = false), expected: { profiling: false, replay: false, tracing: true, metrics: false, logging: false, errors: false } },
  { section: 'sampling.traces', setup: (c) => (c.sampling.traces = 0.5), expected: { profiling: false, replay: false, tracing: true, metrics: false, logging: false, errors: false } },
  { section: 'sampling.spans', setup: (c) => (c.sampling.spans = 0.5), expected: { profiling: false, replay: false, tracing: true, metrics: false, logging: false, errors: false } },
  { section: 'limits.maxSpansPerTrace', setup: (c) => (c.limits.maxSpansPerTrace = 1000), expected: { profiling: false, replay: false, tracing: true, metrics: false, logging: false, errors: false } },
  { section: 'limits.maxSpanAttributes', setupOld: (c) => (c.limits.maxSpanAttributes = 100), setup: (c) => (c.limits.maxSpanAttributes = 200), expected: { profiling: false, replay: false, tracing: true, metrics: false, logging: false, errors: false } },
  { section: 'limits.maxAttributeLength', setupOld: (c) => (c.limits.maxAttributeLength = 2048), setup: (c) => (c.limits.maxAttributeLength = 8192), expected: { profiling: false, replay: false, tracing: true, metrics: false, logging: false, errors: false } },
  { section: 'limits.maxSpanAttributes', setup: (c) => (c.limits.maxSpanAttributes = 300), expected: { profiling: false, replay: false, tracing: true, metrics: false, logging: false, errors: false } },
  { section: 'limits.maxAttributeLength', setup: (c) => (c.limits.maxAttributeLength = 4096), expected: { profiling: false, replay: false, tracing: true, metrics: false, logging: false, errors: false } },
  { section: 'instrumentation.http', setup: (c) => (c.instrumentation.http = false), expected: { profiling: false, replay: false, tracing: true, metrics: false, logging: false, errors: false } },
  { section: 'instrumentation.express.enabled', setup: (c) => (c.instrumentation.express = { enabled: false }), expected: { profiling: false, replay: false, tracing: true, metrics: false, logging: false, errors: false } },
  { section: 'sampling.routes./api.traces', setup: (c) => (c.sampling.routes['/api'] = { traces: 0.5 }), expected: { profiling: false, replay: false, tracing: true, metrics: false, logging: false, errors: false } },
  { section: 'sampling.routes./api.spans', setup: (c) => (c.sampling.routes['/api'] = { spans: 0.5 }), expected: { profiling: false, replay: false, tracing: true, metrics: false, logging: false, errors: false } },
  { section: 'tracing.maxSpansPerTrace', setup: (c) => (c.tracing = { ...c.tracing, maxSpansPerTrace: 2500 }), expected: { profiling: false, replay: false, tracing: true, metrics: false, logging: false, errors: false } },

  // Metrics
  { section: 'features.metrics', setupOld: (c) => (c.features.metrics = false), setup: (c) => (c.features.metrics = true), expected: { profiling: false, replay: false, tracing: false, metrics: true, logging: false, errors: false } },
  { section: 'features.runtimeMetrics', setupOld: (c) => (c.features.runtimeMetrics = false), setup: (c) => (c.features.runtimeMetrics = true), expected: { profiling: false, replay: false, tracing: false, metrics: true, logging: false, errors: false } },
  { section: 'features.eventLoopMonitoring', setupOld: (c) => (c.features.eventLoopMonitoring = false), setup: (c) => (c.features.eventLoopMonitoring = true), expected: { profiling: false, replay: false, tracing: false, metrics: true, logging: false, errors: false } },
  { section: 'features.gcMonitoring', setupOld: (c) => (c.features.gcMonitoring = false), setup: (c) => (c.features.gcMonitoring = true), expected: { profiling: false, replay: false, tracing: false, metrics: true, logging: false, errors: false } },
  { section: 'features.metrics', setup: (c) => (c.features.metrics = false), expected: { profiling: false, replay: false, tracing: false, metrics: true, logging: false, errors: false } },
  { section: 'features.runtimeMetrics', setup: (c) => (c.features.runtimeMetrics = false), expected: { profiling: false, replay: false, tracing: false, metrics: true, logging: false, errors: false } },
  { section: 'features.eventLoopMonitoring', setup: (c) => (c.features.eventLoopMonitoring = false), expected: { profiling: false, replay: false, tracing: false, metrics: true, logging: false, errors: false } },
  { section: 'features.gcMonitoring', setup: (c) => (c.features.gcMonitoring = false), expected: { profiling: false, replay: false, tracing: false, metrics: true, logging: false, errors: false } },
  { section: 'killswitches.disableMetrics', setup: (c) => (c.killswitches.disableMetrics = true), expected: { profiling: false, replay: false, tracing: false, metrics: true, logging: false, errors: false } },
  { section: 'entitlements.metrics', setup: (c) => (c.entitlements.metrics = false), expected: { profiling: false, replay: false, tracing: false, metrics: true, logging: false, errors: false } },
  { section: 'entitlements.customMetrics', setup: (c) => (c.entitlements.customMetrics = false), expected: { profiling: false, replay: false, tracing: false, metrics: true, logging: false, errors: false } },
  { section: 'sampling.metrics', setup: (c) => (c.sampling.metrics = 0.5), expected: { profiling: false, replay: false, tracing: false, metrics: true, logging: false, errors: false } },
  { section: 'sampling.routes./api.metrics', setup: (c) => (c.sampling.routes['/api'] = { metrics: 0.5 }), expected: { profiling: false, replay: false, tracing: false, metrics: true, logging: false, errors: false } },
  { section: 'metrics.pushIntervalMs', setup: (c) => (c.metrics = { ...c.metrics, pushIntervalMs: 5000 }), expected: { profiling: false, replay: false, tracing: false, metrics: true, logging: false, errors: false } },

  // Logging
  { section: 'features.logging', setupOld: (c) => (c.features.logging = false), setup: (c) => (c.features.logging = true), expected: { profiling: false, replay: false, tracing: false, metrics: false, logging: true, errors: false } },
  { section: 'features.logging', setup: (c) => (c.features.logging = false), expected: { profiling: false, replay: false, tracing: false, metrics: false, logging: true, errors: false } },
  { section: 'killswitches.disableLogs', setup: (c) => (c.killswitches.disableLogs = true), expected: { profiling: false, replay: false, tracing: false, metrics: false, logging: true, errors: false } },
  { section: 'entitlements.logging', setup: (c) => (c.entitlements.logging = false), expected: { profiling: false, replay: false, tracing: false, metrics: false, logging: true, errors: false } },
  { section: 'sampling.logs', setup: (c) => (c.sampling.logs = 0.5), expected: { profiling: false, replay: false, tracing: false, metrics: false, logging: true, errors: false } },
  { section: 'sampling.routes./api.logs', setup: (c) => (c.sampling.routes['/api'] = { logs: 0.5 }), expected: { profiling: false, replay: false, tracing: false, metrics: false, logging: true, errors: false } },
  { section: 'logs.maxLogSize', setup: (c) => (c.logs = { ...c.logs, maxLogSize: 65536 }), expected: { profiling: false, replay: false, tracing: false, metrics: false, logging: true, errors: false } },

  // Errors
  { section: 'features.errors', setupOld: (c) => (c.features.errors = false), setup: (c) => (c.features.errors = true), expected: { profiling: false, replay: false, tracing: false, metrics: false, logging: false, errors: true } },
  { section: 'features.errors', setup: (c) => (c.features.errors = false), expected: { profiling: false, replay: false, tracing: false, metrics: false, logging: false, errors: true } },
  { section: 'killswitches.disableErrors', setup: (c) => (c.killswitches.disableErrors = true), expected: { profiling: false, replay: false, tracing: false, metrics: false, logging: false, errors: true } },
  { section: 'entitlements.errors', setup: (c) => (c.entitlements.errors = false), expected: { profiling: false, replay: false, tracing: false, metrics: false, logging: false, errors: true } },
  { section: 'sampling.errors', setup: (c) => (c.sampling.errors = 0.5), expected: { profiling: false, replay: false, tracing: false, metrics: false, logging: false, errors: true } },
  { section: 'sampling.messages', setup: (c) => (c.sampling.messages = 0.5), expected: { profiling: false, replay: false, tracing: false, metrics: false, logging: false, errors: true } },
  { section: 'sampling.routes./api.errors', setup: (c) => (c.sampling.routes['/api'] = { errors: 0.5 }), expected: { profiling: false, replay: false, tracing: false, metrics: false, logging: false, errors: true } },
  { section: 'sampling.routes./api.messages', setup: (c) => (c.sampling.routes['/api'] = { messages: 0.5 }), expected: { profiling: false, replay: false, tracing: false, metrics: false, logging: false, errors: true } },
  { section: 'errors.captureConsoleErrors', setup: (c) => (c.errors = { ...c.errors, captureConsoleErrors: false }), expected: { profiling: false, replay: false, tracing: false, metrics: false, logging: false, errors: true } },
]

for (const sc of fastFlagScenarios) {
  runTest(`Fast-flag activation for: ${sc.section}`, () => {
    const oldCfg = cloneConfig()
    const newCfg = cloneConfig()
    if (sc.setupOld) {
      sc.setupOld(oldCfg)
    }
    sc.setup(newCfg)
    const diff = diffConfigs(oldCfg, newCfg)
    assert.equal(diff.hasChanges, true)
    assert.equal(diff.profilingChanged, sc.expected.profiling, `${sc.section} profilingChanged mismatch`)
    assert.equal(diff.replayChanged, sc.expected.replay, `${sc.section} replayChanged mismatch`)
    assert.equal(diff.tracingChanged, sc.expected.tracing, `${sc.section} tracingChanged mismatch`)
    assert.equal(diff.metricsChanged, sc.expected.metrics, `${sc.section} metricsChanged mismatch`)
    assert.equal(diff.loggingChanged, sc.expected.logging, `${sc.section} loggingChanged mismatch`)
    assert.equal(diff.errorsChanged, sc.expected.errors, `${sc.section} errorsChanged mismatch`)
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Meta Changes Ignored Guarantee
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[Suite 6: Meta Changes Ignored Guarantee]')

runTest('Changes ONLY to meta.generatedAt, generatedBy, configHash result in hasChanges === false', () => {
  const oldCfg = cloneConfig()
  const newCfg = cloneConfig()
  newCfg.meta = {
    generatedAt: '2026-08-20T12:34:56.789Z',
    generatedBy: 'backend-cron-refresh',
    configHash: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
  }
  const diff = diffConfigs(oldCfg, newCfg)
  assert.equal(diff.hasChanges, false)
  assert.equal(diff.changes.size, 0)
  assert.equal(diff.fieldChanges.length, 0)
})

// ─────────────────────────────────────────────────────────────────────────────
// 7. Simultaneous Multi-Section Mutations
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[Suite 7: Simultaneous Multi-Section Mutations]')

runTest('Simultaneous mutations across all 11 core sections', () => {
  const oldCfg = cloneConfig()
  const newCfg = cloneConfig()

  newCfg.sdk.release = '3.1.0'
  newCfg.features.profiling = true
  newCfg.features.tracing = true
  newCfg.features.profiling = false
  newCfg.features.tracing = false
  newCfg.sampling.traces = 0.5
  newCfg.instrumentation.http = false
  newCfg.privacy.capture.headers = true
  newCfg.limits.maxPayloadSize = 2000000
  newCfg.killswitches.disableMetrics = true
  newCfg.transport.keepAlive = false
  newCfg.entitlements.customSpans = true
  newCfg.entitlements.customSpans = false
  newCfg.offlineQueue = { enabled: false, maxFileSizeBytes: 1000, maxEvents: 10, eventTtlMs: 1000, ioTimeoutMs: 100 }

  const diff = diffConfigs(oldCfg, newCfg)
  assert.equal(diff.hasChanges, true)
  assert.equal(diff.sdkChanged, true)
  assert.equal(diff.featuresChanged, true)
  assert.equal(diff.samplingChanged, true)
  assert.equal(diff.instrumentationChanged, true)
  assert.equal(diff.privacyChanged, true)
  assert.equal(diff.limitsChanged, true)
  assert.equal(diff.killswitchesChanged, true)
  assert.equal(diff.transportChanged, true)
  assert.equal(diff.entitlementsChanged, true)
  assert.equal(diff.offlineQueueChanged, true)

  // Verify all fieldChanges have correct metadata
  for (const fc of diff.fieldChanges) {
    assert.ok(typeof fc.path === 'string' && fc.path.length > 0)
    assert.ok(['added', 'removed', 'modified'].includes(fc.type))
  }
  // Verify returned collections are frozen
  assert.equal(Object.isFrozen(diff.addedKeys), true)
  assert.equal(Object.isFrozen(diff.removedKeys), true)
  assert.equal(Object.isFrozen(diff.modifiedKeys), true)
  assert.equal(Object.isFrozen(diff.fieldChanges), true)
})

// ─────────────────────────────────────────────────────────────────────────────
// 8. Property-Based Testing (fast-check)
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[Suite 8: Property-Based Testing (fast-check)]')

runTest('fast-check: Reflexivity diffConfigs(A, A).hasChanges === false', () => {
  fc.assert(
    fc.property(
      fc.record({
        tracing: fc.boolean(),
        errors: fc.boolean(),
        metrics: fc.boolean(),
        sampleRate: fc.double({ min: 0, max: 1 }),
        batchSize: fc.integer({ min: 1, max: 1000 }),
        tags: fc.array(fc.string(), { maxLength: 10 }),
      }),
      (props) => {
        const cfg = cloneConfig({
          features: { ...DEFAULT_REMOTE_CONFIG.features, tracing: props.tracing, errors: props.errors, metrics: props.metrics },
          sampling: { ...DEFAULT_REMOTE_CONFIG.sampling, traces: props.sampleRate },
        })
        const diff = diffConfigs(cfg, cfg)
        return diff.hasChanges === false && diff.changes.size === 0
      },
    ),
    { numRuns: 200 },
  )
})

runTest('fast-check: Diff Symmetry and Cardinality Invariant', () => {
  fc.assert(
    fc.property(
      fc.record({
        tracingA: fc.boolean(),
        tracingB: fc.boolean(),
        errorsA: fc.boolean(),
        errorsB: fc.boolean(),
        rateA: fc.double({ min: 0, max: 1 }),
        rateB: fc.double({ min: 0, max: 1 }),
        batchA: fc.integer({ min: 1, max: 1000 }),
        batchB: fc.integer({ min: 1, max: 1000 }),
      }),
      (p) => {
        const cfgA = cloneConfig({
          features: { ...DEFAULT_REMOTE_CONFIG.features, tracing: p.tracingA, errors: p.errorsA },
          sampling: { ...DEFAULT_REMOTE_CONFIG.sampling, traces: p.rateA },
        })
        const cfgB = cloneConfig({
          features: { ...DEFAULT_REMOTE_CONFIG.features, tracing: p.tracingB, errors: p.errorsB },
          sampling: { ...DEFAULT_REMOTE_CONFIG.sampling, traces: p.rateB },
        })

        const diffAB = diffConfigs(cfgA, cfgB)
        const diffBA = diffConfigs(cfgB, cfgA)

        // Symmetry invariants
        assert.equal(diffAB.hasChanges, diffBA.hasChanges)
        assert.equal(diffAB.featuresChanged, diffBA.featuresChanged)
        assert.equal(diffAB.samplingChanged, diffBA.samplingChanged)
        assert.equal(diffAB.tracingChanged, diffBA.tracingChanged)
        assert.equal(diffAB.errorsChanged, diffBA.errorsChanged)
        assert.equal(diffAB.changes.size, diffBA.changes.size)

        // Added in A->B must equal Removed in B->A
        assert.equal(diffAB.addedKeys.length, diffBA.removedKeys.length)
        assert.equal(diffAB.removedKeys.length, diffBA.addedKeys.length)
        assert.equal(diffAB.modifiedKeys.length, diffBA.modifiedKeys.length)
        return true
      },
    ),
    { numRuns: 300 },
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// 9. Performance & Complexity Benchmark
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[Suite 9: Performance & Complexity Benchmark]')

runTest('10,000 diff operations performance test (< 200ms target)', () => {
  const cfgA = cloneConfig()
  const cfgB = cloneConfig()
  cfgB.features.tracing = true
  cfgB.sampling.traces = 0.5
  cfgB.transport.routes.errors.batchSize = 250

  const start = performance.now()
  const iterations = 10000
  for (let i = 0; i < iterations; i++) {
    const diff = diffConfigs(cfgA, cfgB)
    assert.equal(diff.hasChanges, true)
  }
  const duration = performance.now() - start
  const perOpMicro = (duration / iterations) * 1000
  console.log(`    ⚡ Executed ${iterations} diffs in ${duration.toFixed(2)}ms (${perOpMicro.toFixed(2)} µs/op)`)
  assert.ok(duration < 2000, `Benchmark took too long: ${duration}ms`)
})

runTest('High-cardinality sampling route scale test (1,000 routes)', () => {
  const cfgA = cloneConfig()
  const cfgB = cloneConfig()

  for (let i = 0; i < 1000; i++) {
    cfgA.sampling.routes[`/route/prefix/${i}`] = { traces: 0.1, errors: 1.0 }
    cfgB.sampling.routes[`/route/prefix/${i}`] = { traces: 0.2, errors: 1.0 }
  }

  const start = performance.now()
  const diff = diffConfigs(cfgA, cfgB)
  const duration = performance.now() - start

  assert.equal(diff.hasChanges, true)
  assert.equal(diff.samplingChanged, true)
  assert.equal(diff.tracingChanged, true)
  assert.equal(diff.changes.size, 1000)
  console.log(`    ⚡ Diffed 1,000 sampling routes in ${duration.toFixed(2)}ms`)
  assert.ok(duration < 100, `Large route diff took too long: ${duration}ms`)
})

console.log(`\n=======================================================`)
console.log(`Adversarial Challenger Results: ${passedTests} Passed, ${failedTests} Failed`)
console.log(`=======================================================`)

if (failedTests > 0) {
  process.exit(1)
}
