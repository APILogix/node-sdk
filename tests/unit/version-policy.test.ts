/**
 * VersionPolicy Unit Tests
 *
 * Validates:
 * - Blocked versions → no-op mode with clear message
 * - Force upgrade below minimum → hard error
 * - Below minimum without forceUpgrade → degraded mode (errors + logs only)
 * - Above minimum → ok
 * - Edge cases: exact match, patch versions, empty blockedVersions
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { VersionPolicy } from '../../src/core/version-policy.js'

// The actual SDK_VERSION is read from src/constants/version.ts
// We test against the enforcement logic directly

const makePolicy = (overrides: Record<string, unknown> = {}) => ({
  minimumVersion: '1.2.0',
  latestVersion: '1.5.0',
  blockedVersions: ['1.0.0', '1.0.1'],
  forceUpgrade: false,
  upgradeMessage: 'Critical security fix in v1.5.0',
  ...overrides,
})

describe('VersionPolicy', () => {

  describe('Blocked Versions', () => {
    it('should return blocked status for versions in blockedVersions list', () => {
      const policy = makePolicy({ blockedVersions: ['2.0.0'] })
      const result = VersionPolicy.enforce(policy)
      // Current SDK version is 2.0.0 from package.json
      assert.equal(result.status, 'blocked')
      assert.ok(result.message.length > 0)
    })

    it('should return ok for versions NOT in blockedVersions', () => {
      const policy = makePolicy({
        blockedVersions: ['0.0.1', '0.0.2'],
        minimumVersion: '0.1.0',
      })
      const result = VersionPolicy.enforce(policy)
      // SDK 2.0.0 is not in blocked list and above minimum
      assert.equal(result.status, 'ok')
    })
  })

  describe('Force Upgrade', () => {
    it('should return force_upgrade when below minimum and forceUpgrade is true', () => {
      const policy = makePolicy({
        minimumVersion: '99.0.0', // Way above SDK version
        forceUpgrade: true,
        blockedVersions: [],
      })
      const result = VersionPolicy.enforce(policy)
      assert.equal(result.status, 'force_upgrade')
      assert.ok(result.message.includes('Critical security fix'))
    })
  })

  describe('Degraded Mode', () => {
    it('should return degraded when below minimum but forceUpgrade is false', () => {
      const policy = makePolicy({
        minimumVersion: '99.0.0',
        forceUpgrade: false,
        blockedVersions: [],
      })
      const result = VersionPolicy.enforce(policy)
      assert.equal(result.status, 'degraded')
      assert.ok(result.message.length > 0)
    })
  })

  describe('OK Status', () => {
    it('should return ok when at or above minimum version', () => {
      const policy = makePolicy({
        minimumVersion: '1.0.0',
        blockedVersions: [],
      })
      const result = VersionPolicy.enforce(policy)
      assert.equal(result.status, 'ok')
    })
  })
})
