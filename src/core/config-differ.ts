import type {
  NormalizedRemoteConfig,
  RemoteConfigResponse,
  ConfigDiff,
  FieldChange,
} from '../types/config.js'

/**
 * Diff two remote config snapshots. Returns section-level flags, subsystem fast flags,
 * structured change collections, and detailed field-level change descriptors.
 *
 * Guaranteed crash-proof against null/undefined or corrupted input objects.
 */
export function diffConfigs(
  oldConfig: Readonly<NormalizedRemoteConfig | RemoteConfigResponse> | null | undefined,
  newConfig: Readonly<NormalizedRemoteConfig | RemoteConfigResponse> | null | undefined,
): ConfigDiff {
  const changes = new Map<string, { old: unknown; new: unknown; changeType?: 'added' | 'removed' | 'modified' }>()
  const fieldChanges: FieldChange[] = []
  const addedKeys: string[] = []
  const removedKeys: string[] = []
  const modifiedKeys: string[] = []

  // Fast path: identical reference or both null/undefined
  if (oldConfig === newConfig || (!oldConfig && !newConfig)) {
    return createEmptyDiff()
  }

  // Handle null/undefined boundary cases gracefully
  const safeOld = (oldConfig ?? {}) as Record<string, unknown>
  const safeNew = (newConfig ?? {}) as Record<string, unknown>

  // 1. Top-Level Section Equality Checks
  const sdkChanged = !deepEqual(safeOld['sdk'], safeNew['sdk'])
  const featuresChanged = !deepEqual(safeOld['features'], safeNew['features'])
  const killswitchesChanged = !deepEqual(safeOld['killswitches'], safeNew['killswitches'])
  const samplingChanged = !deepEqual(safeOld['sampling'], safeNew['sampling'])
  const transportChanged = !deepEqual(safeOld['transport'], safeNew['transport'])
  const privacyChanged = !deepEqual(safeOld['privacy'], safeNew['privacy'])
  const limitsChanged = !deepEqual(safeOld['limits'], safeNew['limits'])
  const instrumentationChanged = !deepEqual(safeOld['instrumentation'], safeNew['instrumentation'])
  const entitlementsChanged = !deepEqual(safeOld['entitlements'], safeNew['entitlements'])

  // Optional subsystem sections
  const offlineQueueChanged = safeOld['offlineQueue'] !== undefined || safeNew['offlineQueue'] !== undefined
    ? !deepEqual(safeOld['offlineQueue'], safeNew['offlineQueue'])
    : false
  const profilingSectionChanged = safeOld['profiling'] !== undefined || safeNew['profiling'] !== undefined
    ? !deepEqual(safeOld['profiling'], safeNew['profiling'])
    : false
  const errorsSectionChanged = safeOld['errors'] !== undefined || safeNew['errors'] !== undefined
    ? !deepEqual(safeOld['errors'], safeNew['errors'])
    : false
  const tracingSectionChanged = safeOld['tracing'] !== undefined || safeNew['tracing'] !== undefined
    ? !deepEqual(safeOld['tracing'], safeNew['tracing'])
    : false
  const metricsSectionChanged = safeOld['metrics'] !== undefined || safeNew['metrics'] !== undefined
    ? !deepEqual(safeOld['metrics'], safeNew['metrics'])
    : false
  const logsSectionChanged = safeOld['logs'] !== undefined || safeNew['logs'] !== undefined
    ? !deepEqual(safeOld['logs'], safeNew['logs'])
    : false
  const cronsSectionChanged = safeOld['crons'] !== undefined || safeNew['crons'] !== undefined
    ? !deepEqual(safeOld['crons'], safeNew['crons'])
    : false

  // 2. Recursive Property Traversal across all relevant sections
  if (sdkChanged) collectChanges('sdk', safeOld['sdk'], safeNew['sdk'], changes, fieldChanges, addedKeys, removedKeys, modifiedKeys)
  if (featuresChanged) collectChanges('features', safeOld['features'], safeNew['features'], changes, fieldChanges, addedKeys, removedKeys, modifiedKeys)
  if (killswitchesChanged) collectChanges('killswitches', safeOld['killswitches'], safeNew['killswitches'], changes, fieldChanges, addedKeys, removedKeys, modifiedKeys)
  if (samplingChanged) collectChanges('sampling', safeOld['sampling'], safeNew['sampling'], changes, fieldChanges, addedKeys, removedKeys, modifiedKeys)
  if (transportChanged) collectChanges('transport', safeOld['transport'], safeNew['transport'], changes, fieldChanges, addedKeys, removedKeys, modifiedKeys)
  if (privacyChanged) collectChanges('privacy', safeOld['privacy'], safeNew['privacy'], changes, fieldChanges, addedKeys, removedKeys, modifiedKeys)
  if (limitsChanged) collectChanges('limits', safeOld['limits'], safeNew['limits'], changes, fieldChanges, addedKeys, removedKeys, modifiedKeys)
  if (instrumentationChanged) collectChanges('instrumentation', safeOld['instrumentation'], safeNew['instrumentation'], changes, fieldChanges, addedKeys, removedKeys, modifiedKeys)
  if (entitlementsChanged) collectChanges('entitlements', safeOld['entitlements'], safeNew['entitlements'], changes, fieldChanges, addedKeys, removedKeys, modifiedKeys)

  if (offlineQueueChanged) collectChanges('offlineQueue', safeOld['offlineQueue'], safeNew['offlineQueue'], changes, fieldChanges, addedKeys, removedKeys, modifiedKeys)
  if (profilingSectionChanged) collectChanges('profiling', safeOld['profiling'], safeNew['profiling'], changes, fieldChanges, addedKeys, removedKeys, modifiedKeys)
  if (errorsSectionChanged) collectChanges('errors', safeOld['errors'], safeNew['errors'], changes, fieldChanges, addedKeys, removedKeys, modifiedKeys)
  if (tracingSectionChanged) collectChanges('tracing', safeOld['tracing'], safeNew['tracing'], changes, fieldChanges, addedKeys, removedKeys, modifiedKeys)
  if (metricsSectionChanged) collectChanges('metrics', safeOld['metrics'], safeNew['metrics'], changes, fieldChanges, addedKeys, removedKeys, modifiedKeys)
  if (logsSectionChanged) collectChanges('logs', safeOld['logs'], safeNew['logs'], changes, fieldChanges, addedKeys, removedKeys, modifiedKeys)
  if (cronsSectionChanged) collectChanges('crons', safeOld['crons'], safeNew['crons'], changes, fieldChanges, addedKeys, removedKeys, modifiedKeys)

  // 3. Subsystem Fast-Flag Computation
  const hasChanges = changes.size > 0

  const profilingChanged =
    profilingSectionChanged ||
    hasAnyKey(changes, [
      'features.profiling',
      'killswitches.disableProfiling',
      'entitlements.profiling',
      'sampling.profiles',
    ]) ||
    hasKeyPrefix(changes, 'sampling.routes', 'profiles')

  const tracingChanged =
    tracingSectionChanged ||
    hasAnyKey(changes, [
      'features.tracing',
      'killswitches.disableTracing',
      'entitlements.tracing',
      'entitlements.customSpans',
      'sampling.traces',
      'sampling.spans',
      'limits.maxSpansPerTrace',
      'limits.maxSpanAttributes',
      'limits.maxAttributeLength',
    ]) ||
    instrumentationChanged ||
    hasKeyPrefix(changes, 'sampling.routes', 'traces') ||
    hasKeyPrefix(changes, 'sampling.routes', 'spans')

  const metricsChanged =
    metricsSectionChanged ||
    hasAnyKey(changes, [
      'features.metrics',
      'features.runtimeMetrics',
      'features.eventLoopMonitoring',
      'features.gcMonitoring',
      'killswitches.disableMetrics',
      'entitlements.metrics',
      'entitlements.customMetrics',
      'sampling.metrics',
    ]) ||
    hasKeyPrefix(changes, 'sampling.routes', 'metrics')

  const loggingChanged =
    logsSectionChanged ||
    hasAnyKey(changes, [
      'features.logging',
      'killswitches.disableLogs',
      'entitlements.logging',
      'sampling.logs',
    ]) ||
    hasKeyPrefix(changes, 'sampling.routes', 'logs')

  const errorsChanged =
    errorsSectionChanged ||
    hasAnyKey(changes, [
      'features.errors',
      'killswitches.disableErrors',
      'entitlements.errors',
      'sampling.errors',
      'sampling.messages',
    ]) ||
    hasKeyPrefix(changes, 'sampling.routes', 'errors') ||
    hasKeyPrefix(changes, 'sampling.routes', 'messages')

  return {
    hasChanges,
    sdkChanged,
    featuresChanged,
    killswitchesChanged,
    samplingChanged,
    transportChanged,
    privacyChanged,
    limitsChanged,
    instrumentationChanged,
    entitlementsChanged,
    offlineQueueChanged,
    profilingChanged,
    tracingChanged,
    metricsChanged,
    loggingChanged,
    errorsChanged,
    errorsSectionChanged,
    tracingSectionChanged,
    metricsSectionChanged,
    logsSectionChanged,
    cronsSectionChanged,
    changes,
    addedKeys: Object.freeze(addedKeys),
    removedKeys: Object.freeze(removedKeys),
    modifiedKeys: Object.freeze(modifiedKeys),
    fieldChanges: Object.freeze(fieldChanges),
  } as ConfigDiff
}

function createEmptyDiff(): ConfigDiff {
  return {
    hasChanges: false,
    sdkChanged: false,
    featuresChanged: false,
    killswitchesChanged: false,
    samplingChanged: false,
    transportChanged: false,
    privacyChanged: false,
    limitsChanged: false,
    instrumentationChanged: false,
    entitlementsChanged: false,
    offlineQueueChanged: false,
    profilingChanged: false,
    tracingChanged: false,
    metricsChanged: false,
    loggingChanged: false,
    errorsChanged: false,
    changes: new Map(),
    addedKeys: Object.freeze([]),
    removedKeys: Object.freeze([]),
    modifiedKeys: Object.freeze([]),
    fieldChanges: Object.freeze([]),
  }
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b)) return true
  if (a === null || b === null || a === undefined || b === undefined) return false
  if (typeof a !== typeof b) return false
  if (typeof a !== 'object') return false

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    return a.every((val, idx) => deepEqual(val, b[idx]))
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false

  const aObj = a as Record<string, unknown>
  const bObj = b as Record<string, unknown>
  const aKeys = Object.keys(aObj)
  const bKeys = Object.keys(bObj)

  if (aKeys.length !== bKeys.length) return false
  return aKeys.every(key => Object.prototype.hasOwnProperty.call(bObj, key) && deepEqual(aObj[key], bObj[key]))
}

function collectChanges(
  prefix: string,
  oldVal: unknown,
  newVal: unknown,
  changes: Map<string, { old: unknown; new: unknown; changeType?: 'added' | 'removed' | 'modified' }>,
  fieldChanges: FieldChange[],
  addedKeys: string[],
  removedKeys: string[],
  modifiedKeys: string[],
): void {
  // If oldVal is undefined and newVal is a non-null, non-array object:
  if (oldVal === undefined && typeof newVal === 'object' && newVal !== null && !Array.isArray(newVal)) {
    const newObj = newVal as Record<string, unknown>
    const keys = Object.keys(newObj)
    if (keys.length === 0) {
      changes.set(prefix, { old: undefined, new: newVal, changeType: 'added' })
      fieldChanges.push({ path: prefix, previousValue: undefined, nextValue: newVal, type: 'added' })
      addedKeys.push(prefix)
    } else {
      for (const key of keys) {
        const subPath = prefix ? `${prefix}.${key}` : key
        collectChanges(subPath, undefined, newObj[key], changes, fieldChanges, addedKeys, removedKeys, modifiedKeys)
      }
    }
    return
  }

  // If newVal is undefined and oldVal is a non-null, non-array object:
  if (newVal === undefined && typeof oldVal === 'object' && oldVal !== null && !Array.isArray(oldVal)) {
    const oldObj = oldVal as Record<string, unknown>
    const keys = Object.keys(oldObj)
    if (keys.length === 0) {
      changes.set(prefix, { old: oldVal, new: undefined, changeType: 'removed' })
      fieldChanges.push({ path: prefix, previousValue: oldVal, nextValue: undefined, type: 'removed' })
      removedKeys.push(prefix)
    } else {
      for (const key of keys) {
        const subPath = prefix ? `${prefix}.${key}` : key
        collectChanges(subPath, oldObj[key], undefined, changes, fieldChanges, addedKeys, removedKeys, modifiedKeys)
      }
    }
    return
  }

  // If either side is not an object or is null/array, treat as leaf property
  if (
    typeof oldVal !== 'object' ||
    typeof newVal !== 'object' ||
    oldVal === null ||
    newVal === null ||
    Array.isArray(oldVal) ||
    Array.isArray(newVal)
  ) {
    if (!deepEqual(oldVal, newVal)) {
      const type: 'added' | 'removed' | 'modified' =
        oldVal === undefined ? 'added' : newVal === undefined ? 'removed' : 'modified'

      changes.set(prefix, { old: oldVal, new: newVal, changeType: type })
      fieldChanges.push({ path: prefix, previousValue: oldVal, nextValue: newVal, type })

      if (type === 'added') addedKeys.push(prefix)
      else if (type === 'removed') removedKeys.push(prefix)
      else modifiedKeys.push(prefix)
    }
    return
  }

  const oldObj = oldVal as Record<string, unknown>
  const newObj = newVal as Record<string, unknown>
  const allKeys = new Set([...Object.keys(oldObj), ...Object.keys(newObj)])

  for (const key of allKeys) {
    const subPath = prefix ? `${prefix}.${key}` : key
    const hasOld = Object.prototype.hasOwnProperty.call(oldObj, key)
    const hasNew = Object.prototype.hasOwnProperty.call(newObj, key)

    if (hasOld && !hasNew) {
      collectChanges(subPath, oldObj[key], undefined, changes, fieldChanges, addedKeys, removedKeys, modifiedKeys)
    } else if (!hasOld && hasNew) {
      collectChanges(subPath, undefined, newObj[key], changes, fieldChanges, addedKeys, removedKeys, modifiedKeys)
    } else {
      const oVal = oldObj[key]
      const nVal = newObj[key]
      if (!deepEqual(oVal, nVal)) {
        collectChanges(subPath, oVal, nVal, changes, fieldChanges, addedKeys, removedKeys, modifiedKeys)
      }
    }
  }
}

function hasAnyKey(changes: Map<string, unknown>, keys: readonly string[]): boolean {
  for (const key of keys) {
    if (changes.has(key)) return true
  }
  return false
}

function hasKeyPrefix(changes: Map<string, unknown>, prefix: string, suffix: string): boolean {
  for (const [key, val] of changes.entries()) {
    if (key.startsWith(prefix)) {
      if (key.endsWith(`.${suffix}`) || key.includes(`.${suffix}.`) || key === `${prefix}.${suffix}`) {
        return true
      }
      if (val && typeof val === 'object') {
        const oldVal = (val as any).old
        const newVal = (val as any).new
        if (oldVal && typeof oldVal === 'object' && suffix in oldVal) return true
        if (newVal && typeof newVal === 'object' && suffix in newVal) return true
      }
    }
  }
  return false
}
