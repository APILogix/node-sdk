/**
 * Remote Config Integration Tests
 *
 * Validates the end-to-end integration of all remote config modules
 * working together — without making real network requests.
 *
 * Tests:
 * - Full config lifecycle: initialize → snapshot → diff → refresh
 * - Killswitch ↔ FeatureController interaction
 * - SamplingEngine ↔ LimitsEngine interaction
 * - SecurityScrubber as final pipeline stage
 * - Config refresh triggering all subsystem updates
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
// All remote config modules
import { SamplingEngine } from '../../src/core/sampling-engine.js';
import { KillswitchEngine } from '../../src/core/killswitch-engine.js';
import { FeatureController } from '../../src/core/feature-controller.js';
import { LimitsEngine } from '../../src/core/limits-engine.js';
import { SecurityScrubber } from '../../src/processors/security-scrubber.js';
import { VersionPolicy } from '../../src/core/version-policy.js';
import { diffConfigs } from '../../src/core/config-differ.js';
import { BAKED_IN_REMOTE_CONFIG } from '../../src/constants/defaults.js';
// ─── Helpers ────────────────────────────────────────────────────────────────
function makeRemoteConfig(overrides = {}) {
    return { ...BAKED_IN_REMOTE_CONFIG, ...overrides };
}
const defaultFeatures = {
    tracing: true,
    metrics: true,
    logging: true,
    errors: true,
    profiling: false,
    crons: false,
    sessionReplay: false,
    aiDetection: false,
    dynamicSampling: false,
    runtimeMetrics: false,
    eventLoopMonitoring: false,
    gcMonitoring: false,
    sourceMaps: false,
    releaseTracking: false,
};
// ─── Tests ──────────────────────────────────────────────────────────────────
describe('Remote Config Integration', () => {
    afterEach(() => {
        SamplingEngine.reset();
        KillswitchEngine.reset();
        FeatureController.reset();
        LimitsEngine.reset();
        SecurityScrubber.reset();
    });
    describe('Full Control Plane Initialization', () => {
        it('should initialize all engines from a single config snapshot', () => {
            const config = makeRemoteConfig();
            // Initialize all engines — mirrors init.ts Phase 4
            const killswitch = KillswitchEngine.initialize(config.killswitches);
            const features = FeatureController.initialize(config.features);
            const sampling = SamplingEngine.initialize(config.sampling);
            const limits = LimitsEngine.initialize(config.limits);
            const scrubber = SecurityScrubber.initialize(config.security);
            // All should be valid singletons
            assert.ok(KillswitchEngine.getInstance() !== null);
            assert.ok(FeatureController.getInstance() !== null);
            assert.ok(SamplingEngine.getInstance() !== null);
            assert.ok(LimitsEngine.getInstance() !== null);
            assert.ok(SecurityScrubber.getInstance() !== null);
            // SDK should not be disabled
            assert.equal(killswitch.isSDKDisabled(), false);
        });
    });
    describe('Killswitch ↔ FeatureController Interaction', () => {
        it('should prevent feature from running when killswitch is active', () => {
            const killswitch = KillswitchEngine.initialize({
                disableSDK: false,
                disableTracing: true, // Tracing killed
                disableMetrics: false,
                disableTransport: false,
                disableProfiling: false,
                disableErrors: false,
                disableLogs: false,
            });
            const features = FeatureController.initialize(defaultFeatures);
            // Feature says tracing is enabled...
            assert.equal(features.isEnabled('tracing'), true);
            // ...but killswitch overrides it
            assert.equal(killswitch.isKilled('disableTracing'), true);
            // In the event pipeline, the combined check is:
            // if (killswitch.isKilled('disableTracing')) → drop span events
            // This mirrors the actual isFeatureEnabled() logic
            const shouldProcessSpan = !killswitch.isKilled('disableTracing') && features.isEnabled('tracing');
            assert.equal(shouldProcessSpan, false);
        });
        it('should allow feature when neither killswitch nor feature flag blocks', () => {
            KillswitchEngine.initialize({
                disableSDK: false,
                disableTracing: false,
                disableMetrics: false,
                disableTransport: false,
                disableProfiling: false,
                disableErrors: false,
                disableLogs: false,
            });
            const features = FeatureController.initialize(defaultFeatures);
            const killswitch = KillswitchEngine.getInstance();
            const shouldProcessSpan = !killswitch.isKilled('disableTracing') && features.isEnabled('tracing');
            assert.equal(shouldProcessSpan, true);
        });
    });
    describe('SamplingEngine ↔ SecurityScrubber Pipeline', () => {
        it('should sample then scrub an event in correct order', () => {
            const sampling = SamplingEngine.initialize({
                traces: 1.0, // Always sample
                errors: 1.0,
                profiles: 0,
                replays: 0,
                routes: {},
            });
            const scrubber = SecurityScrubber.initialize({
                scrubbing: {
                    enabled: true,
                    headers: ['authorization'],
                    bodyFields: ['password'],
                    queryParams: ['token'],
                },
                piiDetection: { enabled: true, maskEmails: true, maskPhones: false, maskIPs: false },
            });
            // Step 1: Sampling decision
            const decision = sampling.shouldSampleTrace('trace-123');
            assert.equal(decision.sampled, true);
            // Step 2: Scrubbing (happens after sampling in the pipeline)
            const event = {
                type: 'request',
                headers: { 'Authorization': 'Bearer secret' },
                context: { password: 'hunter2' },
                message: 'User admin@test.com logged in',
            };
            const scrubbed = scrubber.scrub(event);
            assert.equal(scrubbed.headers['Authorization'], '[Redacted]');
            assert.equal(scrubbed.context.password, '[Redacted]');
            assert.ok(scrubbed.message.includes('[email]'));
        });
    });
    describe('LimitsEngine Rate + Attribute Pipeline', () => {
        it('should rate-limit then enforce attributes on admitted events', () => {
            const limits = LimitsEngine.initialize({
                maxPayloadSize: 262144,
                maxAttributesPerEvent: 3,
                maxAttributeLength: 50,
                maxBreadcrumbs: 5,
                maxEventsPerSecond: 1000,
                maxMemoryUsageMb: 256,
                maxCpuOverheadPercent: 5,
            });
            // Admit event (should succeed with 1000/s budget)
            assert.equal(limits.admitEvent(), true);
            // Enforce attributes — should trim 5 attrs to 3
            const event = {
                type: 'span',
                attributes: {
                    'key1': 'short',
                    'key2': 'x'.repeat(100), // Will be truncated
                    'key3': 'also short',
                    'key4': 'will be trimmed',
                    'key5': 'also trimmed',
                },
            };
            const enforced = limits.enforceAttributeLimits(event);
            const attrCount = Object.keys(enforced.attributes).length;
            assert.ok(attrCount <= 3, `Expected at most 3 attributes, got ${attrCount}`);
            // The long value should be truncated
            const val = enforced.attributes['key2'];
            if (typeof val === 'string') {
                assert.ok(val.length <= 51, `Expected truncated value, got length ${val.length}`);
            }
        });
    });
    describe('Config Refresh Simulation', () => {
        it('should propagate config changes to all engines via diff', () => {
            const config1 = makeRemoteConfig();
            const config2 = makeRemoteConfig({
                killswitches: { ...BAKED_IN_REMOTE_CONFIG.killswitches, disableTracing: true },
                sampling: { ...BAKED_IN_REMOTE_CONFIG.sampling, traces: 0.1 },
            });
            // Initialize with config1
            const killswitch = KillswitchEngine.initialize(config1.killswitches);
            const sampling = SamplingEngine.initialize(config1.sampling);
            // Diff
            const diff = diffConfigs(config1, config2);
            assert.equal(diff.killswitchesChanged, true);
            assert.equal(diff.samplingChanged, true);
            // Apply changes
            killswitch.handleConfigChange(diff, config2);
            sampling.handleConfigChange(diff, config2);
            // Verify changes took effect
            assert.equal(killswitch.isKilled('disableTracing'), true);
            assert.equal(sampling.getConfig().traces, 0.1);
        });
    });
    describe('Version Policy Gate', () => {
        it('should block initialization when SDK version is in blockedVersions', () => {
            // SDK version is "2.0.0" — block it
            const result = VersionPolicy.enforce({
                minimumVersion: '1.0.0',
                latestVersion: '2.1.0',
                blockedVersions: ['2.0.0'],
                forceUpgrade: false,
                upgradeMessage: 'Version 2.0.0 has a critical bug',
            });
            assert.equal(result.status, 'blocked');
        });
        it('should allow initialization when SDK version is healthy', () => {
            const result = VersionPolicy.enforce({
                minimumVersion: '1.0.0',
                latestVersion: '2.1.0',
                blockedVersions: [],
                forceUpgrade: false,
                upgradeMessage: '',
            });
            assert.equal(result.status, 'ok');
        });
    });
    describe('Degraded Mode: Errors + Logs Only', () => {
        it('should only allow errors and logging features in degraded mode', () => {
            const features = FeatureController.initialize(defaultFeatures);
            features.setDegradedMode(true);
            // Only errors and logging should be enabled
            assert.equal(features.isEnabled('errors'), true);
            assert.equal(features.isEnabled('logging'), true);
            // Everything else must be disabled
            assert.equal(features.isEnabled('tracing'), false);
            assert.equal(features.isEnabled('metrics'), false);
            assert.equal(features.isEnabled('profiling'), false);
            assert.equal(features.isEnabled('crons'), false);
            assert.equal(features.isEnabled('sessionReplay'), false);
        });
    });
});
