/**
 * ConfigDiffer — deep-diff utility for RemoteConfigResponse objects.
 *
 * Used by the config refresh loop to determine which sections changed
 * and what subsystems need dynamic reconfiguration.
 */

import type { RemoteConfigResponse, ConfigDiff } from '../types/config.js'

/**
 * Deep-diff two remote config objects.
 * Returns a ConfigDiff describing which top-level sections changed.
 */
export function diffConfigs(
  oldConfig: Readonly<RemoteConfigResponse>,
  newConfig: Readonly<RemoteConfigResponse>
): ConfigDiff {
  const changes = new Map<string, { old: unknown; new: unknown }>()

  const featuresChanged = !deepEqual(oldConfig.features, newConfig.features)
  const killswitchesChanged = !deepEqual(oldConfig.killswitches, newConfig.killswitches)
  const samplingChanged = !deepEqual(oldConfig.sampling, newConfig.sampling)
  const transportChanged = !deepEqual(oldConfig.transport, newConfig.transport)
  const securityChanged = !deepEqual(oldConfig.security, newConfig.security)
  const tracingChanged = !deepEqual(oldConfig.tracing, newConfig.tracing)
  const errorsChanged = !deepEqual(oldConfig.errors, newConfig.errors)
  const loggingChanged = !deepEqual(oldConfig.logging, newConfig.logging)
  const metricsChanged = !deepEqual(oldConfig.metrics, newConfig.metrics)
  const profilingChanged = !deepEqual(oldConfig.profiling, newConfig.profiling)
  const limitsChanged = !deepEqual(oldConfig.limits, newConfig.limits)
  const instrumentationChanged = !deepEqual(oldConfig.instrumentation, newConfig.instrumentation)

  if (featuresChanged) collectChanges('features', oldConfig.features, newConfig.features, changes)
  if (killswitchesChanged) collectChanges('killswitches', oldConfig.killswitches, newConfig.killswitches, changes)
  if (samplingChanged) collectChanges('sampling', oldConfig.sampling, newConfig.sampling, changes)
  if (transportChanged) changes.set('transport', { old: '[complex]', new: '[complex]' })
  if (securityChanged) changes.set('security', { old: '[complex]', new: '[complex]' })
  if (tracingChanged) collectChanges('tracing', oldConfig.tracing, newConfig.tracing, changes)
  if (errorsChanged) collectChanges('errors', oldConfig.errors, newConfig.errors, changes)
  if (loggingChanged) collectChanges('logging', oldConfig.logging, newConfig.logging, changes)
  if (metricsChanged) collectChanges('metrics', oldConfig.metrics, newConfig.metrics, changes)
  if (profilingChanged) collectChanges('profiling', oldConfig.profiling, newConfig.profiling, changes)
  if (limitsChanged) collectChanges('limits', oldConfig.limits, newConfig.limits, changes)
  if (instrumentationChanged) changes.set('instrumentation', { old: '[complex]', new: '[complex]' })

  return {
    featuresChanged,
    killswitchesChanged,
    samplingChanged,
    transportChanged,
    securityChanged,
    tracingChanged,
    errorsChanged,
    loggingChanged,
    metricsChanged,
    profilingChanged,
    limitsChanged,
    instrumentationChanged,
    changes,
  }
}

/**
 * Deep equality check for two values.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || b === null) return false
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
  return aKeys.every(key => deepEqual(aObj[key], bObj[key]))
}

/**
 * Collect per-field changes for diagnostics.
 */
function collectChanges(
  prefix: string,
  oldVal: unknown,
  newVal: unknown,
  changes: Map<string, { old: unknown; new: unknown }>
): void {
  if (typeof oldVal !== 'object' || typeof newVal !== 'object' || oldVal === null || newVal === null) {
    changes.set(prefix, { old: oldVal, new: newVal })
    return
  }

  const oldObj = oldVal as Record<string, unknown>
  const newObj = newVal as Record<string, unknown>
  const allKeys = new Set([...Object.keys(oldObj), ...Object.keys(newObj)])

  for (const key of allKeys) {
    if (!deepEqual(oldObj[key], newObj[key])) {
      changes.set(`${prefix}.${key}`, { old: oldObj[key], new: newObj[key] })
    }
  }
}
