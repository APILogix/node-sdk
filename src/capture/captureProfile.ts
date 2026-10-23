import { ProfilingSubsystem } from '../subsystems/profiling-subsystem.js'
import { client } from '../core/client.js'
import { EntitlementGate } from '../core/entitlement-gate.js'
import { SamplingEngine } from '../core/sampling-engine.js'

/**
 * Manually start a CPU profile.
 * Note: The SDK automatically profiles traces if `features.profiling` is enabled
 * and the trace is sampled for profiling. This manual API allows capturing
 * arbitrary profiles outside of the automatic trace lifecycle.
 *
 * No-op when the `profiling` entitlement is revoked: returns `false` and
 * nothing is recorded.
 *
 * @param profileId A unique identifier for this profile session.
 * @returns boolean indicating if profiling successfully started.
 */
export async function startProfile(profileId: string): Promise<boolean> {
  if (!EntitlementGate.isAllowed('profiling')) return false
  if (!client.initialized) return false
  const subsystem = ProfilingSubsystem.getInstance()
  if (!subsystem) return false

  // Deterministic sampling for manual profiles. The backend can throttle
  // profile ingestion via `sampling.profiles` without disabling the
  // profiling subsystem entirely.
  const samplingEngine = SamplingEngine.getInstance()
  if (samplingEngine) {
    const decision = samplingEngine.shouldSampleProfile(profileId)
    if (!decision.sampled) return false
  }

  return subsystem.startCpuProfile(profileId)
}

/**
 * Stop a manually started CPU profile.
 * The profile payload will be emitted to the 'profiles' transport route.
 *
 * No-op when the `profiling` entitlement is revoked.
 *
 * @param profileId The unique identifier passed to `startProfile()`.
 */
export async function stopProfile(profileId: string): Promise<void> {
  if (!EntitlementGate.isAllowed('profiling')) return
  if (!client.initialized) return
  const subsystem = ProfilingSubsystem.getInstance()
  if (!subsystem) return

  return subsystem.stopCpuProfile(profileId)
}

/**
 * Manually start a Heap allocation profile.
 * Samples allocations via the V8 SamplingHeapProfiler.
 *
 * @param profileId A unique identifier for this profile session.
 * @returns boolean indicating if profiling successfully started.
 */
export async function startHeapProfile(profileId: string): Promise<boolean> {
  if (!EntitlementGate.isAllowed('profiling')) return false
  if (!client.initialized) return false
  const subsystem = ProfilingSubsystem.getInstance()
  if (!subsystem) return false

  const samplingEngine = SamplingEngine.getInstance()
  if (samplingEngine) {
    const decision = samplingEngine.shouldSampleProfile(profileId)
    if (!decision.sampled) return false
  }

  return subsystem.startHeapProfile(profileId)
}

/**
 * Stop a manually started Heap allocation profile.
 *
 * @param profileId The unique identifier passed to `startHeapProfile()`.
 */
export async function stopHeapProfile(profileId: string): Promise<void> {
  if (!EntitlementGate.isAllowed('profiling')) return
  if (!client.initialized) return
  const subsystem = ProfilingSubsystem.getInstance()
  if (!subsystem) return

  return subsystem.stopHeapProfile(profileId)
}
