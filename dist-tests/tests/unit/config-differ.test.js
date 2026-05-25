/**
 * ConfigDiffer (diffConfigs) unit tests.
 *
 * Validates:
 *   - Deep diff between two remote-config snapshots.
 *   - Detects per-section changes: features, killswitches, sampling,
 *     transport, privacy, limits, instrumentation, runtime.
 *   - Empty diff when configs are identical.
 *   - Per-field changes recorded in the `changes` Map.
 *
 * The set of "changed" booleans was rewritten in v3 — `securityChanged`
 * became `privacyChanged`, the per-feature blocks (tracing, errors,
 * logging, metrics, profiling) collapsed into the SDK-internal
 * defaults so they no longer appear on `ConfigDiff`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { diffConfigs } from '../../src/core/config-differ.js';
import { BAKED_IN_REMOTE_CONFIG } from '../../src/constants/defaults.js';
function makeConfig(overrides = {}) {
    return { ...BAKED_IN_REMOTE_CONFIG, ...overrides };
}
describe('diffConfigs', () => {
    describe('Identical Configs', () => {
        it('should return no changes for identical configs', () => {
            const config = makeConfig();
            const diff = diffConfigs(config, config);
            assert.equal(diff.featuresChanged, false);
            assert.equal(diff.killswitchesChanged, false);
            assert.equal(diff.samplingChanged, false);
            assert.equal(diff.transportChanged, false);
            assert.equal(diff.privacyChanged, false);
            assert.equal(diff.limitsChanged, false);
            assert.equal(diff.instrumentationChanged, false);
            assert.equal(diff.runtimeChanged, false);
            assert.equal(diff.changes.size, 0);
        });
    });
    describe('Sampling Changes', () => {
        it('should detect sampling rate change', () => {
            const old = makeConfig();
            const next = makeConfig({
                sampling: { ...BAKED_IN_REMOTE_CONFIG.sampling, traces: 0.8 },
            });
            const diff = diffConfigs(old, next);
            assert.equal(diff.samplingChanged, true);
            assert.ok(diff.changes.has('sampling.traces'));
        });
        it('should detect new requests sampling rate', () => {
            const old = makeConfig();
            const next = makeConfig({
                sampling: { ...BAKED_IN_REMOTE_CONFIG.sampling, requests: 0.5 },
            });
            const diff = diffConfigs(old, next);
            assert.equal(diff.samplingChanged, true);
            assert.ok(diff.changes.has('sampling.requests'));
        });
    });
    describe('Killswitch Changes', () => {
        it('should detect killswitch flip', () => {
            const old = makeConfig();
            const next = makeConfig({
                killswitches: { ...BAKED_IN_REMOTE_CONFIG.killswitches, disableTracing: true },
            });
            const diff = diffConfigs(old, next);
            assert.equal(diff.killswitchesChanged, true);
            assert.ok(diff.changes.has('killswitches.disableTracing'));
        });
    });
    describe('Features Changes', () => {
        it('should detect feature toggle', () => {
            const old = makeConfig();
            const next = makeConfig({
                features: { ...BAKED_IN_REMOTE_CONFIG.features, tracing: !BAKED_IN_REMOTE_CONFIG.features.tracing },
            });
            const diff = diffConfigs(old, next);
            assert.equal(diff.featuresChanged, true);
        });
        it('should detect requestCapture flip independently of tracing', () => {
            const old = makeConfig();
            const next = makeConfig({
                features: { ...BAKED_IN_REMOTE_CONFIG.features, requestCapture: !BAKED_IN_REMOTE_CONFIG.features.requestCapture },
            });
            const diff = diffConfigs(old, next);
            assert.equal(diff.featuresChanged, true);
            assert.ok(diff.changes.has('features.requestCapture'));
        });
    });
    describe('Limits Changes', () => {
        it('should detect maxQueueSize change', () => {
            const old = makeConfig();
            const next = makeConfig({
                limits: { ...BAKED_IN_REMOTE_CONFIG.limits, maxQueueSize: 50_000 },
            });
            const diff = diffConfigs(old, next);
            assert.equal(diff.limitsChanged, true);
        });
    });
    describe('Privacy Changes', () => {
        it('should detect scrubbing rule change', () => {
            const old = makeConfig();
            const next = makeConfig({
                privacy: {
                    ...BAKED_IN_REMOTE_CONFIG.privacy,
                    scrubbing: {
                        ...BAKED_IN_REMOTE_CONFIG.privacy.scrubbing,
                        fields: ['password', 'token', 'newSecretField'],
                    },
                },
            });
            const diff = diffConfigs(old, next);
            assert.equal(diff.privacyChanged, true);
        });
    });
    describe('Runtime Changes', () => {
        it('should detect TTL change', () => {
            const old = makeConfig();
            const next = makeConfig({
                runtime: { ...BAKED_IN_REMOTE_CONFIG.runtime, configTtlSeconds: 60 },
            });
            const diff = diffConfigs(old, next);
            assert.equal(diff.runtimeChanged, true);
        });
    });
    describe('Multiple Sections Changed', () => {
        it('should detect changes across multiple sections simultaneously', () => {
            const old = makeConfig();
            const next = makeConfig({
                sampling: { ...BAKED_IN_REMOTE_CONFIG.sampling, traces: 0.99 },
                killswitches: { ...BAKED_IN_REMOTE_CONFIG.killswitches, disableSDK: true },
                limits: { ...BAKED_IN_REMOTE_CONFIG.limits, maxQueueSize: 1 },
            });
            const diff = diffConfigs(old, next);
            assert.equal(diff.samplingChanged, true);
            assert.equal(diff.killswitchesChanged, true);
            assert.equal(diff.limitsChanged, true);
            // Unchanged sections
            assert.equal(diff.featuresChanged, false);
            assert.equal(diff.privacyChanged, false);
        });
    });
});
