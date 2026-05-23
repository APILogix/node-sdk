/**
 * VersionPolicy — enforces version policy before SDK initialization.
 *
 * Enforcement order:
 * 1. blockedVersions — if current version is blocked → fatal error, no-op mode, reject init
 * 2. forceUpgrade + below minimumVersion → hard error, refuse to initialize
 * 3. below minimumVersion (no forceUpgrade) → degraded mode (errors + logs only), persistent warning
 * 4. below latestVersion → informational log
 * 5. otherwise → OK
 */
import type { VersionPolicyConfig } from '../types/config.js';
/** Result of version policy enforcement. */
export type VersionPolicyResult = {
    readonly status: 'ok';
} | {
    readonly status: 'blocked';
    readonly message: string;
} | {
    readonly status: 'force_upgrade';
    readonly message: string;
} | {
    readonly status: 'degraded';
    readonly message: string;
};
export declare class VersionPolicy {
    /**
     * Enforce the version policy against the running SDK version.
     *
     * The caller must act on the result:
     * - 'blocked' → reject init promise, enter no-op mode
     * - 'force_upgrade' → throw hard error, refuse to initialize
     * - 'degraded' → init with only errors + logs, persistent warning
     * - 'ok' → proceed normally
     */
    static enforce(policy: VersionPolicyConfig): VersionPolicyResult;
    /**
     * Compare two semantic versions.
     * Returns: -1 if a < b, 0 if a === b, 1 if a > b.
     * Handles pre-release tags by stripping them for comparison.
     */
    static compareSemver(a: string, b: string): -1 | 0 | 1;
}
//# sourceMappingURL=version-policy.d.ts.map