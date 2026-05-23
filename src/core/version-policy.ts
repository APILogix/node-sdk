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

import { SDK_VERSION } from '../constants/version.js'
import type { VersionPolicyConfig } from '../types/config.js'
import { getLogger } from '../utils/logger.js'

/** Result of version policy enforcement. */
export type VersionPolicyResult =
  | { readonly status: 'ok' }
  | { readonly status: 'blocked'; readonly message: string }
  | { readonly status: 'force_upgrade'; readonly message: string }
  | { readonly status: 'degraded'; readonly message: string }

export class VersionPolicy {
  /**
   * Enforce the version policy against the running SDK version.
   *
   * The caller must act on the result:
   * - 'blocked' → reject init promise, enter no-op mode
   * - 'force_upgrade' → throw hard error, refuse to initialize
   * - 'degraded' → init with only errors + logs, persistent warning
   * - 'ok' → proceed normally
   */
  static enforce(policy: VersionPolicyConfig): VersionPolicyResult {
    const logger = getLogger()
    const currentVersion = SDK_VERSION

    // Check 1: Is the current version explicitly blocked?
    if (policy.blockedVersions.includes(currentVersion)) {
      const message = `SDK version ${currentVersion} is blocked. ${
        policy.upgradeMessage || `Please upgrade to ${policy.latestVersion}.`
      }`
      logger.error(`[VersionPolicy] FATAL: ${message}`)
      return { status: 'blocked', message }
    }

    // Check 2: Below minimum version?
    if (VersionPolicy.compareSemver(currentVersion, policy.minimumVersion) < 0) {
      if (policy.forceUpgrade) {
        const message = `SDK version ${currentVersion} is below minimum ${policy.minimumVersion} and forceUpgrade is enabled. ${
          policy.upgradeMessage || `Please upgrade to ${policy.latestVersion}.`
        }`
        logger.error(`[VersionPolicy] FATAL: ${message}`)
        return { status: 'force_upgrade', message }
      }

      // Degraded mode — only errors + logs
      const message = `SDK version ${currentVersion} is below minimum ${policy.minimumVersion}. Running in degraded mode (errors + logs only). ${
        policy.upgradeMessage || `Please upgrade to ${policy.latestVersion}.`
      }`
      logger.warn(`[VersionPolicy] WARNING: ${message}`)
      return { status: 'degraded', message }
    }

    // Check 3: Below latest? Informational
    if (VersionPolicy.compareSemver(currentVersion, policy.latestVersion) < 0) {
      logger.info(
        `[VersionPolicy] A newer SDK version ${policy.latestVersion} is available. ${policy.upgradeMessage || ''}`
      )
    }

    return { status: 'ok' }
  }

  /**
   * Compare two semantic versions.
   * Returns: -1 if a < b, 0 if a === b, 1 if a > b.
   * Handles pre-release tags by stripping them for comparison.
   */
  static compareSemver(a: string, b: string): -1 | 0 | 1 {
    const parseVersion = (v: string): [number, number, number] => {
      const clean = v.replace(/^v/, '').split('-')[0]!
      const parts = clean.split('.')
      return [
        parseInt(parts[0] ?? '0', 10),
        parseInt(parts[1] ?? '0', 10),
        parseInt(parts[2] ?? '0', 10),
      ]
    }

    const [aMajor, aMinor, aPatch] = parseVersion(a)
    const [bMajor, bMinor, bPatch] = parseVersion(b)

    if (aMajor !== bMajor) return aMajor < bMajor ? -1 : 1
    if (aMinor !== bMinor) return aMinor < bMinor ? -1 : 1
    if (aPatch !== bPatch) return aPatch < bPatch ? -1 : 1
    return 0
  }
}
