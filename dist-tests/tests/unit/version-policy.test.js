/**
 * VersionPolicy unit tests.
 *
 * The wire schema in v3 dropped the `versionPolicy` block, so the engine
 * was reduced to a stub that always returns `{ status: 'ok' }`. The
 * static `compareSemver()` helper survives because some non-config code
 * paths still use it for semantic-version arithmetic.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { VersionPolicy } from '../../src/core/version-policy.js';
describe('VersionPolicy.enforce (stub)', () => {
    it('always returns ok regardless of input', () => {
        assert.equal(VersionPolicy.enforce().status, 'ok');
        assert.equal(VersionPolicy.enforce({ minimumVersion: '99.0.0', blockedVersions: [], forceUpgrade: true }).status, 'ok');
    });
});
describe('VersionPolicy.compareSemver', () => {
    it('reports equal versions as 0', () => {
        assert.equal(VersionPolicy.compareSemver('1.2.3', '1.2.3'), 0);
    });
    it('reports a < b as -1', () => {
        assert.equal(VersionPolicy.compareSemver('1.2.3', '1.2.4'), -1);
        assert.equal(VersionPolicy.compareSemver('1.2.3', '1.3.0'), -1);
        assert.equal(VersionPolicy.compareSemver('1.2.3', '2.0.0'), -1);
    });
    it('reports a > b as 1', () => {
        assert.equal(VersionPolicy.compareSemver('1.2.4', '1.2.3'), 1);
        assert.equal(VersionPolicy.compareSemver('1.3.0', '1.2.99'), 1);
        assert.equal(VersionPolicy.compareSemver('2.0.0', '1.99.99'), 1);
    });
    it('strips leading v prefix', () => {
        assert.equal(VersionPolicy.compareSemver('v1.2.3', '1.2.3'), 0);
    });
    it('ignores pre-release suffixes', () => {
        assert.equal(VersionPolicy.compareSemver('1.2.3-rc.1', '1.2.3'), 0);
    });
});
