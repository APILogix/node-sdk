/**
 * Remote-config integration tests.
 *
 * Validates the end-to-end interaction between every engine that reads
 * the wire schema — without making any real network calls. Each test
 * mirrors a slice of the actual `init.ts` orchestration so a regression
 * in any engine's contract surfaces here.
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { SamplingEngine } from '../../src/core/sampling-engine.js';
import { KillswitchEngine } from '../../src/core/killswitch-engine.js';
import { FeatureController } from '../../src/core/feature-controller.js';
import { LimitsEngine } from '../../src/core/limits-engine.js';
import { SecurityScrubber } from '../../src/processors/security-scrubber.js';
import { VersionPolicy } from '../../src/core/version-policy.js';
import { diffConfigs } from '../../src/core/config-differ.js';
import { BAKED_IN_REMOTE_CONFIG } from '../../src/constants/defaults.js';
function makeRemoteConfig(overrides = {}) {
    return { ...BAKED_IN_REMOTE_CONFIG, ...overrides };
}
const defaultFeatures = {
    tracing: true,
    requestCapture: true,
    errors: true,
    metrics: true,
    logging: true,
    profiling: false,
    crons: false,
    sessionReplay: false,
    runtimeMetrics: false,
    eventLoopMonitoring: false,
    gcMonitoring: false,
};
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
            const killswitch = KillswitchEngine.initialize(config.killswitches);
            FeatureController.initialize(config.features);
            SamplingEngine.initialize(config.sampling);
            LimitsEngine.initialize(config.limits);
            SecurityScrubber.initialize(config.privacy);
            assert.ok(KillswitchEngine.getInstance() !== null);
            assert.ok(FeatureController.getInstance() !== null);
            assert.ok(SamplingEngine.getInstance() !== null);
            assert.ok(LimitsEngine.getInstance() !== null);
            assert.ok(SecurityScrubber.getInstance() !== null);
            assert.equal(killswitch.isSDKDisabled(), false);
        });
    });
    describe('Killswitch ↔ FeatureController Interaction', () => {
        it('should prevent feature from running when killswitch is active', () => {
            const killswitch = KillswitchEngine.initialize({
                disableSDK: false,
                disableTracing: true,
                disableMetrics: false,
                disableTransport: false,
                disableProfiling: false,
                disableErrors: false,
                disableLogs: false,
            });
            const features = FeatureController.initialize(defaultFeatures);
            assert.equal(features.isEnabled('tracing'), true);
            assert.equal(killswitch.isKilled('disableTracing'), true);
            // Mirror of `isFeatureEnabled` in event-pipeline.ts
            const shouldProcessSpan = !killswitch.isKilled('disableTracing') && features.isEnabled('tracing');
            assert.equal(shouldProcessSpan, false);
        });
        it('should allow feature when neither killswitch nor feature flag blocks', () => {
            const killswitch = KillswitchEngine.initialize({
                disableSDK: false,
                disableTracing: false,
                disableMetrics: false,
                disableTransport: false,
                disableProfiling: false,
                disableErrors: false,
                disableLogs: false,
            });
            const features = FeatureController.initialize(defaultFeatures);
            const shouldProcessSpan = !killswitch.isKilled('disableTracing') && features.isEnabled('tracing');
            assert.equal(shouldProcessSpan, true);
        });
        it('should treat requestCapture as independent of tracing', () => {
            const killswitch = KillswitchEngine.initialize({
                disableSDK: false,
                disableTracing: false,
                disableMetrics: false,
                disableTransport: false,
                disableProfiling: false,
                disableErrors: false,
                disableLogs: false,
            });
            const features = FeatureController.initialize({
                ...defaultFeatures,
                requestCapture: false, // request capture explicitly off
            });
            assert.equal(features.isEnabled('tracing'), true);
            assert.equal(features.isEnabled('requestCapture'), false);
            // The capture gate would drop request events even though tracing is on.
        });
    });
    describe('SamplingEngine ↔ SecurityScrubber Pipeline', () => {
        it('should sample then scrub an event in correct order', () => {
            const sampling = SamplingEngine.initialize({
                traces: 1.0,
                requests: 1.0,
                errors: 1.0,
                profiles: 0,
                replays: 0,
                metrics: 1.0,
                routes: {},
            });
            const scrubber = SecurityScrubber.initialize({
                capture: { headers: true, body: true, response: false, query: true, cookies: false },
                scrubbing: {
                    enabled: true,
                    headers: ['authorization'],
                    fields: ['password', 'token'],
                },
                piiDetection: { enabled: true, maskEmails: true, maskPhones: false, maskIPs: false },
            });
            // Sampling decision
            const decision = sampling.shouldSampleTrace('trace-123');
            assert.equal(decision.sampled, true);
            // Scrubbing
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
    describe('LimitsEngine Attribute Pipeline', () => {
        it('should enforce attribute count and length on events', () => {
            const limits = LimitsEngine.initialize({
                maxSpansPerTrace: 500,
                maxSpanAttributes: 3,
                maxAttributeLength: 50,
                maxPayloadSize: 262144,
                maxQueueSize: 10000,
                maxMemoryMb: 256,
                maxCpuOverheadPercent: 5,
            });
            const event = {
                type: 'span',
                attributes: {
                    key1: 'short',
                    key2: 'x'.repeat(100),
                    key3: 'also short',
                    key4: 'will be trimmed',
                    key5: 'also trimmed',
                },
            };
            const enforced = limits.enforceAttributeLimits(event);
            const attrCount = Object.keys(enforced.attributes).length;
            assert.ok(attrCount <= 3, `expected ≤3 attributes, got ${attrCount}`);
            const val = enforced.attributes['key2'];
            if (typeof val === 'string') {
                assert.ok(val.length <= 51, `expected truncated, got length ${val.length}`);
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
            const killswitch = KillswitchEngine.initialize(config1.killswitches);
            const sampling = SamplingEngine.initialize(config1.sampling);
            const diff = diffConfigs(config1, config2);
            assert.equal(diff.killswitchesChanged, true);
            assert.equal(diff.samplingChanged, true);
            killswitch.handleConfigChange(diff, config2);
            sampling.handleConfigChange(diff, config2);
            assert.equal(killswitch.isKilled('disableTracing'), true);
            assert.equal(sampling.getConfig().traces, 0.1);
        });
    });
    describe('Version Policy', () => {
        it('always returns ok in v3 (stub)', () => {
            // The wire schema dropped versionPolicy. The `enforce()` API is kept
            // as a stub that always returns "ok" so legacy callsites compile.
            const result = VersionPolicy.enforce();
            assert.equal(result.status, 'ok');
        });
    });
    describe('Degraded Mode', () => {
        it('should only allow errors and logging features in degraded mode', () => {
            const features = FeatureController.initialize(defaultFeatures);
            features.setDegradedMode(true);
            assert.equal(features.isEnabled('errors'), true);
            assert.equal(features.isEnabled('logging'), true);
            assert.equal(features.isEnabled('tracing'), false);
            assert.equal(features.isEnabled('metrics'), false);
            assert.equal(features.isEnabled('profiling'), false);
            assert.equal(features.isEnabled('crons'), false);
            assert.equal(features.isEnabled('sessionReplay'), false);
            assert.equal(features.isEnabled('requestCapture'), false);
        });
    });
});
