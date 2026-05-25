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
export class VersionPolicy {
    static enforce(_policy) {
        return { status: 'ok' };
    }
    /**
     * Compare two semver strings: returns -1 / 0 / 1. Retained because some
     * non-config code paths still use it for version arithmetic.
     */
    static compareSemver(a, b) {
        const parseVersion = (v) => {
            const clean = v.replace(/^v/, '').split('-')[0];
            const parts = clean.split('.');
            return [
                parseInt(parts[0] ?? '0', 10),
                parseInt(parts[1] ?? '0', 10),
                parseInt(parts[2] ?? '0', 10),
            ];
        };
        const [aMajor, aMinor, aPatch] = parseVersion(a);
        const [bMajor, bMinor, bPatch] = parseVersion(b);
        if (aMajor !== bMajor)
            return aMajor < bMajor ? -1 : 1;
        if (aMinor !== bMinor)
            return aMinor < bMinor ? -1 : 1;
        if (aPatch !== bPatch)
            return aPatch < bPatch ? -1 : 1;
        return 0;
    }
}
