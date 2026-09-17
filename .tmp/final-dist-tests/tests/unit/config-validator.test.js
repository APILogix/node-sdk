import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateRemoteConfig, assertRemoteConfig, isRemoteConfigResponse, isNormalizedRemoteConfig, deepFreeze, normalizeRemoteConfig, validateOrFallback, } from '../../src/core/config-validator.js';
import { SAFETY_CEILINGS } from '../../src/constants/limits.js';
import { DEFAULT_REMOTE_CONFIG } from '../../src/constants/defaults.js';
import { TEST_REMOTE_CONFIG } from '../fixtures/remote-config.js';
function cloneConfig(overrides = {}) {
    return JSON.parse(JSON.stringify({ ...TEST_REMOTE_CONFIG, ...overrides }));
}
describe('ConfigValidator Unit Test Suite', () => {
    describe('1. Safe Defaults & Full Valid Configuration', () => {
        it('validates complete default remote config with zero errors', () => {
            const result = validateRemoteConfig(DEFAULT_REMOTE_CONFIG);
            assert.equal(result.valid, true, `Expected valid default config, got errors: ${result.errors.join('; ')}`);
            assert.equal(result.errors.length, 0);
        });
        it('validates complete test remote config fixture with zero errors', () => {
            const result = validateRemoteConfig(TEST_REMOTE_CONFIG);
            assert.equal(result.valid, true, `Expected valid config, got errors: ${result.errors.join('; ')}`);
            assert.equal(result.errors.length, 0);
        });
        it('assertRemoteConfig passes without throwing on valid configuration', () => {
            assert.doesNotThrow(() => {
                assertRemoteConfig(TEST_REMOTE_CONFIG);
            });
        });
        it('isRemoteConfigResponse and isNormalizedRemoteConfig return true for valid configuration', () => {
            assert.equal(isRemoteConfigResponse(TEST_REMOTE_CONFIG), true);
            assert.equal(isNormalizedRemoteConfig(TEST_REMOTE_CONFIG), true);
        });
        it('validates all 10 required transport routes', () => {
            const routes = [
                'traces', 'requests', 'spans', 'errors', 'metrics',
                'logs', 'profiles', 'events', 'crons', 'replays',
            ];
            for (const route of routes) {
                const config = cloneConfig();
                delete config.transport.routes[route];
                const result = validateRemoteConfig(config);
                assert.equal(result.valid, false);
                assert.match(result.errors.join(' '), new RegExp(`transport\\.routes\\.${route}`));
            }
        });
        it('validates complex route-specific sampling overrides', () => {
            const config = cloneConfig({
                sampling: {
                    ...TEST_REMOTE_CONFIG.sampling,
                    routes: {
                        '/health': { traces: 0, requests: 0, logs: 0 },
                        '/api/v1/auth': { traces: 1.0, requests: 1.0, errors: 1.0 },
                        '/api/v1/search': { traces: 0.25, profiles: 0.1 },
                    },
                },
            });
            const result = validateRemoteConfig(config);
            assert.equal(result.valid, true, `Errors: ${result.errors.join('; ')}`);
        });
    });
    describe('2. Corrupted Payloads, Primitives & Null Checks', () => {
        it('rejects null payload', () => {
            const result = validateRemoteConfig(null);
            assert.equal(result.valid, false);
            assert.match(result.errors.join(' '), /not a JSON object/);
        });
        it('rejects undefined payload', () => {
            const result = validateRemoteConfig(undefined);
            assert.equal(result.valid, false);
            assert.match(result.errors.join(' '), /not a JSON object/);
        });
        it('rejects array payload', () => {
            const result = validateRemoteConfig([1, 2, 3]);
            assert.equal(result.valid, false);
            assert.match(result.errors.join(' '), /not a JSON object/);
        });
        it('rejects primitive strings and numbers', () => {
            assert.equal(validateRemoteConfig('{"valid": "json"}').valid, false);
            assert.equal(validateRemoteConfig(12345).valid, false);
            assert.equal(validateRemoteConfig(true).valid, false);
            assert.equal(validateRemoteConfig(NaN).valid, false);
        });
        it('assertRemoteConfig throws formatted error message on invalid payload', () => {
            assert.throws(() => assertRemoteConfig({ schemaVersion: 1 }), /Remote config validation failed/);
        });
    });
    describe('3. Partial Remote Config & Missing Mandatory Sections', () => {
        const mandatorySections = [
            'sdk', 'features', 'sampling', 'instrumentation',
            'privacy', 'limits', 'killswitches', 'transport', 'meta', 'entitlements',
        ];
        for (const section of mandatorySections) {
            it(`rejects payload when section "${section}" is missing`, () => {
                const config = cloneConfig();
                delete config[section];
                const result = validateRemoteConfig(config);
                assert.equal(result.valid, false);
                assert.match(result.errors.join(' '), new RegExp(section));
            });
        }
        it('rejects missing schemaVersion', () => {
            const config = cloneConfig();
            delete config.schemaVersion;
            const result = validateRemoteConfig(config);
            assert.equal(result.valid, false);
            assert.match(result.errors.join(' '), /schemaVersion/);
        });
        it('rejects future schemaVersion greater than client supported version', () => {
            const config = cloneConfig({ schemaVersion: 99 });
            const result = validateRemoteConfig(config);
            assert.equal(result.valid, false);
            assert.match(result.errors.join(' '), /package upgrade required/);
        });
    });
    describe('4. Type Validation & Malformed Sub-Fields', () => {
        it('rejects non-string sdk.projectId', () => {
            const config = cloneConfig();
            config.sdk.projectId = 12345;
            const result = validateRemoteConfig(config);
            assert.equal(result.valid, false);
            assert.match(result.errors.join(' '), /sdk\.projectId/);
        });
        it('rejects empty string sdk.projectId', () => {
            const config = cloneConfig();
            config.sdk.projectId = '   ';
            const result = validateRemoteConfig(config);
            assert.equal(result.valid, false);
            assert.match(result.errors.join(' '), /sdk\.projectId/);
        });
        it('rejects non-boolean feature toggles', () => {
            const config = cloneConfig();
            config.features.tracing = 'true';
            const result = validateRemoteConfig(config);
            assert.equal(result.valid, false);
            assert.match(result.errors.join(' '), /features\.tracing/);
        });
        it('rejects non-boolean killswitch toggles', () => {
            const config = cloneConfig();
            config.killswitches.disableSDK = 1;
            const result = validateRemoteConfig(config);
            assert.equal(result.valid, false);
            assert.match(result.errors.join(' '), /killswitches\.disableSDK/);
        });
        it('rejects non-object sampling.routes', () => {
            const config = cloneConfig();
            config.sampling.routes = ['/health'];
            const result = validateRemoteConfig(config);
            assert.equal(result.valid, false);
            assert.match(result.errors.join(' '), /sampling\.routes/);
        });
        it('rejects empty prefix in sampling.routes', () => {
            const config = cloneConfig();
            config.sampling.routes = { '': { traces: 0.5 } };
            const result = validateRemoteConfig(config);
            assert.equal(result.valid, false);
            assert.match(result.errors.join(' '), /sampling\.routes contains an empty route prefix/);
        });
        it('rejects invalid sampling families in sampling.routes', () => {
            const config = cloneConfig();
            config.sampling.routes = { '/api': { unknownTelemetry: 0.5 } };
            const result = validateRemoteConfig(config);
            assert.equal(result.valid, false);
            assert.match(result.errors.join(' '), /not a supported sampling family/);
        });
        it('rejects invalid transport retry backoff strategies', () => {
            const config = cloneConfig();
            config.transport.retry.backoff = 'random-backoff';
            const result = validateRemoteConfig(config);
            assert.equal(result.valid, false);
            assert.match(result.errors.join(' '), /transport\.retry\.backoff/);
        });
        it('rejects invalid transport queue overflow strategies', () => {
            const config = cloneConfig();
            config.transport.queue.overflowStrategy = 'drop_random';
            const result = validateRemoteConfig(config);
            assert.equal(result.valid, false);
            assert.match(result.errors.join(' '), /transport\.queue\.overflowStrategy/);
        });
    });
    describe('5. Safety Ceilings & Boundary Numbers', () => {
        it('rejects negative sampling rates (< 0.0)', () => {
            const config = cloneConfig();
            config.sampling.traces = -0.01;
            const result = validateRemoteConfig(config);
            assert.equal(result.valid, false);
            assert.match(result.errors.join(' '), /sampling\.traces/);
        });
        it('rejects sampling rates exceeding 1.0', () => {
            const config = cloneConfig();
            config.sampling.errors = 1.05;
            const result = validateRemoteConfig(config);
            assert.equal(result.valid, false);
            assert.match(result.errors.join(' '), /sampling\.errors/);
        });
        it('accepts exact boundary sampling rates (0.0 and 1.0)', () => {
            const config = cloneConfig();
            config.sampling.traces = 0.0;
            config.sampling.requests = 1.0;
            const result = validateRemoteConfig(config);
            assert.equal(result.valid, true);
        });
        it('rejects limits.maxSpansPerTrace exceeding SAFETY_CEILINGS', () => {
            const config = cloneConfig();
            config.limits.maxSpansPerTrace = SAFETY_CEILINGS.maxSpansPerTrace + 1;
            const result = validateRemoteConfig(config);
            assert.equal(result.valid, false);
            assert.match(result.errors.join(' '), /limits\.maxSpansPerTrace/);
        });
        it('rejects limits.maxSpanAttributes exceeding SAFETY_CEILINGS', () => {
            const config = cloneConfig();
            config.limits.maxSpanAttributes = SAFETY_CEILINGS.maxSpanAttributes + 1;
            const result = validateRemoteConfig(config);
            assert.equal(result.valid, false);
            assert.match(result.errors.join(' '), /limits\.maxSpanAttributes/);
        });
        it('rejects limits.maxPayloadSize exceeding SAFETY_CEILINGS (4MB)', () => {
            const config = cloneConfig();
            config.limits.maxPayloadSize = SAFETY_CEILINGS.maxPayloadSize + 1;
            const result = validateRemoteConfig(config);
            assert.equal(result.valid, false);
            assert.match(result.errors.join(' '), /limits\.maxPayloadSize/);
        });
        it('rejects limits.maxQueueSize exceeding SAFETY_CEILINGS (100,000)', () => {
            const config = cloneConfig();
            config.limits.maxQueueSize = SAFETY_CEILINGS.maxQueueSize + 1;
            const result = validateRemoteConfig(config);
            assert.equal(result.valid, false);
            assert.match(result.errors.join(' '), /limits\.maxQueueSize/);
        });
        it('rejects invalid limits.persistenceGovernance values', () => {
            const config = cloneConfig();
            config.limits.persistenceGovernance.maxPersistPerMinute = SAFETY_CEILINGS.maxPersistPerMinute + 1;
            config.limits.persistenceGovernance.adaptive = 'true';
            config.limits.persistenceGovernance.budgetExceededLogIntervalMs = 0;
            const result = validateRemoteConfig(config);
            assert.equal(result.valid, false);
            assert.match(result.errors.join(' '), /limits\.persistenceGovernance\.maxPersistPerMinute/);
            assert.match(result.errors.join(' '), /limits\.persistenceGovernance\.adaptive/);
            assert.match(result.errors.join(' '), /limits\.persistenceGovernance\.budgetExceededLogIntervalMs/);
        });
        it('rejects transport.routes.*.batchSize exceeding SAFETY_CEILINGS (5,000)', () => {
            const config = cloneConfig();
            config.transport.routes.traces.batchSize = SAFETY_CEILINGS.batchSize + 1;
            const result = validateRemoteConfig(config);
            assert.equal(result.valid, false);
            assert.match(result.errors.join(' '), /transport\.routes\.traces\.batchSize/);
        });
        it('rejects transport.routes.*.timeoutMs under 250ms or exceeding 60,000ms', () => {
            const config1 = cloneConfig();
            config1.transport.routes.errors.timeoutMs = 200;
            assert.equal(validateRemoteConfig(config1).valid, false);
            const config2 = cloneConfig();
            config2.transport.routes.errors.timeoutMs = SAFETY_CEILINGS.timeoutMs + 1;
            assert.equal(validateRemoteConfig(config2).valid, false);
        });
        it('rejects transport.retry.maxRetries exceeding SAFETY_CEILINGS (10)', () => {
            const config = cloneConfig();
            config.transport.retry.maxRetries = SAFETY_CEILINGS.retryMaxRetries + 1;
            const result = validateRemoteConfig(config);
            assert.equal(result.valid, false);
            assert.match(result.errors.join(' '), /transport\.retry\.maxRetries/);
        });
    });
    describe('6. Unknown Keys, Deprecated Fields & Forward Compatibility', () => {
        it('tolerates unknown top-level keys for forward compatibility', () => {
            const config = cloneConfig({ futureExtensionField: { enabled: true, version: 2 } });
            const result = validateRemoteConfig(config);
            assert.equal(result.valid, true);
        });
        it('rejects deprecated limits.maxCpuOverheadPercent policy', () => {
            const config = cloneConfig();
            config.limits.maxCpuOverheadPercent = 10;
            const result = validateRemoteConfig(config);
            assert.equal(result.valid, false);
            assert.match(result.errors.join(' '), /maxCpuOverheadPercent is no longer supported/);
        });
    });
    describe('7. Cross-Section Invariants', () => {
        it('rejects transport.queue.maxSize exceeding limits.maxQueueSize', () => {
            const config = cloneConfig();
            config.limits.maxQueueSize = 5000;
            config.transport.queue.maxSize = 10000;
            const result = validateRemoteConfig(config);
            assert.equal(result.valid, false);
            assert.match(result.errors.join(' '), /transport\.queue\.maxSize cannot exceed limits\.maxQueueSize/);
        });
        it('rejects transport.queue.criticalReserve exceeding transport.queue.maxSize', () => {
            const config = cloneConfig();
            config.transport.queue.maxSize = 1000;
            config.transport.queue.criticalReserve = 1500;
            const result = validateRemoteConfig(config);
            assert.equal(result.valid, false);
            assert.match(result.errors.join(' '), /transport\.queue\.criticalReserve cannot exceed transport\.queue\.maxSize/);
        });
    });
    describe('8. Transport URL Sanitization & Security', () => {
        it('rejects transport URLs containing user credentials', () => {
            const config = cloneConfig();
            config.transport.routes.errors.url = 'https://admin:secret123@api.pulse.dev/v1/errors';
            const result = validateRemoteConfig(config);
            assert.equal(result.valid, false);
            assert.match(result.errors.join(' '), /transport\.routes\.errors\.url/);
        });
        it('rejects non-HTTP/HTTPS URLs (e.g. ftp, file, ws)', () => {
            const config = cloneConfig();
            config.transport.routes.traces.url = 'ftp://traces.pulse.dev/upload';
            const result = validateRemoteConfig(config);
            assert.equal(result.valid, false);
            assert.match(result.errors.join(' '), /transport\.routes\.traces\.url/);
        });
        it('accepts localhost plain HTTP transport URLs', () => {
            const config = cloneConfig();
            config.transport.routes.traces.url = 'http://127.0.0.1:8080/v1/traces';
            const result = validateRemoteConfig(config);
            assert.equal(result.valid, true);
        });
    });
    describe('9. Optional Subsystem Sections', () => {
        it('validates optional subsystem sections when present', () => {
            const config = cloneConfig({
                offlineQueue: {
                    enabled: true,
                    maxFileSizeBytes: 10 * 1024 * 1024,
                    maxEvents: 5000,
                    eventTtlMs: 86400000,
                    ioTimeoutMs: 5000,
                },
                profiling: {
                    enabled: true,
                    cpu: true,
                    heap: true,
                    sampleRate: 0.5,
                    maxDurationMs: 30000,
                },
                replay: {
                    enabled: true,
                    sampleRate: 0.1,
                    idleTimeoutMs: 60000,
                    maxDurationMs: 3600000,
                },
                errors: {
                    captureUnhandledRejections: true,
                    captureUncaughtExceptions: true,
                    captureConsoleErrors: true,
                    stackTraceLimit: 50,
                    attachSourceContext: true,
                    grouping: { enabled: true, normalizePaths: true },
                },
                tracing: {
                    maxSpansPerTrace: 1000,
                    maxSpanAttributes: 50,
                    maxTraceDurationMs: 60000,
                    propagation: { w3c: true, baggage: true, b3: false },
                },
                metrics: {
                    runtimeMetrics: true,
                    eventLoopMonitoring: true,
                    gcMonitoring: true,
                    pushIntervalMs: 10000,
                    cardinalityLimit: 1000,
                },
                logs: {
                    enabled: true,
                    captureConsole: true,
                    levels: ['info', 'error'],
                    maxLogSize: 16384,
                },
                crons: {
                    enabled: true,
                    checkInMarginMs: 30000,
                    timeoutMs: 60000,
                },
            });
            const result = validateRemoteConfig(config);
            assert.equal(result.valid, true, `Errors: ${result.errors.join('; ')}`);
        });
    });
    describe('10. Deep Freeze, Normalizer & Fallback Resolver', () => {
        it('deepFreeze recursively freezes objects and arrays', () => {
            const obj = { a: 1, nested: { b: 2, arr: [1, 2, 3] } };
            const frozen = deepFreeze(obj);
            assert.equal(Object.isFrozen(frozen), true);
            assert.equal(Object.isFrozen(frozen.nested), true);
            assert.equal(Object.isFrozen(frozen.nested.arr), true);
        });
        it('deepFreeze handles circular references safely', () => {
            const circular = { name: 'circular' };
            circular.self = circular;
            assert.doesNotThrow(() => {
                deepFreeze(circular);
            });
            assert.equal(Object.isFrozen(circular), true);
        });
        it('normalizeRemoteConfig sets service identity and canonical hash if omitted', () => {
            const base = cloneConfig();
            delete base.sdk.service;
            delete base.meta.configHash;
            const normalized = normalizeRemoteConfig(base);
            assert.equal(normalized.sdk.service, base.sdk.projectId);
            assert.ok(normalized.meta.configHash?.startsWith('sha256:'));
            assert.equal(Object.isFrozen(normalized), true);
        });
        it('validateOrFallback returns fallback config with usedFallback true for malformed payload', () => {
            const { config, valid, errors, usedFallback } = validateOrFallback({ invalidPayload: true });
            assert.equal(valid, false);
            assert.equal(usedFallback, true);
            assert.ok(errors.length > 0);
            assert.equal(config.schemaVersion, DEFAULT_REMOTE_CONFIG.schemaVersion);
            assert.equal(Object.isFrozen(config), true);
        });
        it('validateOrFallback returns normalized config with usedFallback false for valid payload', () => {
            const { config, valid, errors, usedFallback } = validateOrFallback(TEST_REMOTE_CONFIG);
            assert.equal(valid, true);
            assert.equal(usedFallback, false);
            assert.equal(errors.length, 0);
            assert.equal(config.sdk.projectId, TEST_REMOTE_CONFIG.sdk.projectId);
            assert.equal(Object.isFrozen(config), true);
        });
    });
});
