/**
 * VersionPolicy — stub.
 *
 * The wire schema (post-migration) no longer carries a `versionPolicy`
 * block. Version gating is a feature we may bring back, but it lives
 * entirely on the backend now: if a customer's SDK is too old, the
 * backend can simply refuse to issue a config (HTTP 426 Upgrade Required)
 * and the SDK already enters its degraded "no remote config" mode.
 *
 * This class is kept as a stable shape so legacy call sites in `init.ts`
 * still compile during the transition. Every call returns `{ status: 'ok' }`.
 */
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
    static enforce(_policy?: unknown): VersionPolicyResult;
    /**
     * Compare two semver strings: returns -1 / 0 / 1. Retained because some
     * non-config code paths still use it for version arithmetic.
     */
    static compareSemver(a: string, b: string): -1 | 0 | 1;
}
//# sourceMappingURL=version-policy.d.ts.map