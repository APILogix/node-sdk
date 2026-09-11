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
export declare function startProfile(profileId: string): Promise<boolean>;
/**
 * Stop a manually started CPU profile.
 * The profile payload will be emitted to the 'profiles' transport route.
 *
 * No-op when the `profiling` entitlement is revoked.
 *
 * @param profileId The unique identifier passed to `startProfile()`.
 */
export declare function stopProfile(profileId: string): Promise<void>;
