import { ProfilingSubsystem } from '../subsystems/profiling-subsystem.js';
import { client } from '../core/client.js';
import { EntitlementGate } from '../core/entitlement-gate.js';
import { SamplingEngine } from '../core/sampling-engine.js';
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
export async function startProfile(profileId) {
    if (!EntitlementGate.isAllowed('profiling'))
        return false;
    if (!client.initialized)
        return false;
    const subsystem = ProfilingSubsystem.getInstance();
    if (!subsystem)
        return false;
    // Deterministic sampling for manual profiles. The backend can throttle
    // profile ingestion via `sampling.profiles` without disabling the
    // profiling subsystem entirely.
    const samplingEngine = SamplingEngine.getInstance();
    if (samplingEngine) {
        const decision = samplingEngine.shouldSampleProfile(profileId);
        if (!decision.sampled)
            return false;
    }
    return subsystem.startCpuProfile(profileId);
}
/**
 * Stop a manually started CPU profile.
 * The profile payload will be emitted to the 'profiles' transport route.
 *
 * No-op when the `profiling` entitlement is revoked.
 *
 * @param profileId The unique identifier passed to `startProfile()`.
 */
export async function stopProfile(profileId) {
    if (!EntitlementGate.isAllowed('profiling'))
        return;
    if (!client.initialized)
        return;
    const subsystem = ProfilingSubsystem.getInstance();
    if (!subsystem)
        return;
    return subsystem.stopCpuProfile(profileId);
}
//# sourceMappingURL=captureProfile.js.map