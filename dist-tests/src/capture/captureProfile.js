import { ProfilingSubsystem } from '../subsystems/profiling-subsystem.js';
import { client } from '../core/client.js';
/**
 * Manually start a CPU profile.
 * Note: The SDK automatically profiles traces if `features.profiling` is enabled
 * and the trace is sampled for profiling. This manual API allows capturing
 * arbitrary profiles outside of the automatic trace lifecycle.
 *
 * @param profileId A unique identifier for this profile session.
 * @returns boolean indicating if profiling successfully started.
 */
export async function startProfile(profileId) {
    if (!client.initialized)
        return false;
    const subsystem = ProfilingSubsystem.getInstance();
    if (!subsystem)
        return false;
    return subsystem.startCpuProfile(profileId);
}
/**
 * Stop a manually started CPU profile.
 * The profile payload will be emitted to the 'profiles' transport route.
 *
 * @param profileId The unique identifier passed to `startProfile()`.
 */
export async function stopProfile(profileId) {
    if (!client.initialized)
        return;
    const subsystem = ProfilingSubsystem.getInstance();
    if (!subsystem)
        return;
    return subsystem.stopCpuProfile(profileId);
}
