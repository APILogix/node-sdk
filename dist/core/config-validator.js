import { createHash } from 'node:crypto';
import { REMOTE_CONFIG_SCHEMA_VERSION } from '../types/config.js';
import { SAFETY_CEILINGS } from '../constants/limits.js';
import { DEFAULT_REMOTE_CONFIG } from '../constants/defaults.js';
const FEATURE_KEYS = [
    'tracing', 'requestCapture', 'errors', 'metrics', 'logging', 'profiling',
    'crons', 'sessionReplay', 'runtimeMetrics', 'eventLoopMonitoring', 'gcMonitoring',
];
const SAMPLING_KEYS = [
    'traces', 'requests', 'spans', 'errors', 'messages', 'profiles',
    'replays', 'metrics', 'logs', 'events', 'crons',
];
const KILLSWITCH_KEYS = [
    'disableSDK', 'disableTracing', 'disableMetrics', 'disableTransport',
    'disableProfiling', 'disableErrors', 'disableLogs',
];
const ENTITLEMENT_KEYS = [
    'customSpans', 'customMetrics', 'profiling', 'logging', 'sessionReplay',
    'crons', 'requestCapture', 'tracing', 'errors', 'metrics',
];
const REQUIRED_ROUTES = [
    'traces', 'requests', 'spans', 'errors', 'metrics', 'logs', 'profiles',
    'events', 'crons', 'replays',
];
/**
 * Validate a complete replacement snapshot against Schema v1 and safety bounds.
 * No defaults, deep merges, or partial patches are accepted: either every subsystem
 * can consume the document or the entire document is rejected.
 */
export function validateRemoteConfig(payload) {
    const errors = [];
    if (!isRecord(payload))
        return invalid('payload is not a JSON object');
    const config = payload;
    // 1. Schema Version
    integer(config, 'schemaVersion', errors, 1, REMOTE_CONFIG_SCHEMA_VERSION);
    if (typeof config['schemaVersion'] === 'number' && config['schemaVersion'] > REMOTE_CONFIG_SCHEMA_VERSION) {
        errors.push(`schemaVersion ${config['schemaVersion']} is newer than client-supported ${REMOTE_CONFIG_SCHEMA_VERSION}; package upgrade required`);
    }
    // 2. Mandatory Sections
    validateIdentity(config['sdk'], errors);
    validateBooleanSection(config['features'], 'features', FEATURE_KEYS, errors);
    validateSampling(config['sampling'], errors);
    validateInstrumentation(config['instrumentation'], errors);
    validatePrivacy(config['privacy'], errors);
    validateLimits(config['limits'], errors);
    validateBooleanSection(config['killswitches'], 'killswitches', KILLSWITCH_KEYS, errors);
    validateTransport(config['transport'], errors);
    validateMeta(config['meta'], errors);
    validateBooleanSection(config['entitlements'], 'entitlements', ENTITLEMENT_KEYS, errors);
    // 3. Optional Subsystem Sections (if present)
    if (config['offlineQueue'] !== undefined)
        validateOfflineQueue(config['offlineQueue'], errors);
    if (config['profiling'] !== undefined)
        validateProfiling(config['profiling'], errors);
    if (config['replay'] !== undefined)
        validateReplay(config['replay'], errors);
    if (config['errors'] !== undefined)
        validateErrors(config['errors'], errors);
    if (config['tracing'] !== undefined)
        validateTracing(config['tracing'], errors);
    if (config['metrics'] !== undefined)
        validateMetrics(config['metrics'], errors);
    if (config['logs'] !== undefined)
        validateLogs(config['logs'], errors);
    if (config['crons'] !== undefined)
        validateCrons(config['crons'], errors);
    // 4. Cross-Section Invariants
    validateCrossSectionInvariants(config, errors);
    return { valid: errors.length === 0, errors };
}
export function assertRemoteConfig(payload) {
    const result = validateRemoteConfig(payload);
    if (!result.valid) {
        throw new Error(`Remote config validation failed: ${result.errors.slice(0, 8).join('; ')}`
            + (result.errors.length > 8 ? ` (+${result.errors.length - 8} more)` : ''));
    }
}
export function isRemoteConfigResponse(value) {
    return validateRemoteConfig(value).valid;
}
export function isNormalizedRemoteConfig(value) {
    return validateRemoteConfig(value).valid;
}
/**
 * Recursively freezes any JavaScript object or array, protecting against circular structures.
 */
export function deepFreeze(value, visited = new WeakSet()) {
    if (value && typeof value === 'object') {
        if (visited.has(value) || Object.isFrozen(value)) {
            return value;
        }
        visited.add(value);
        for (const nested of Object.values(value)) {
            if (nested && typeof nested === 'object') {
                deepFreeze(nested, visited);
            }
        }
        Object.freeze(value);
    }
    return value;
}
/**
 * Normalizes a candidate wire payload into a guaranteed, deep-frozen NormalizedRemoteConfig.
 * If payload is invalid or malformed, uses fallback configuration.
 */
export function normalizeRemoteConfig(payload, fallback = DEFAULT_REMOTE_CONFIG) {
    const result = validateRemoteConfig(payload);
    if (!result.valid || !isRecord(payload)) {
        return deepFreeze(structuredClone(fallback));
    }
    const clone = structuredClone(payload);
    const hashSource = structuredClone(clone);
    if (isRecord(hashSource['meta'])) {
        const metaObj = { ...hashSource['meta'] };
        delete metaObj['configHash'];
        hashSource['meta'] = metaObj;
    }
    const hash = createHash('sha256').update(stableStringify(hashSource)).digest('hex');
    const canonicalHash = `sha256:${hash}`;
    const normalized = {
        ...clone,
        sdk: {
            ...clone.sdk,
            service: clone.sdk.service ?? clone.sdk.projectId,
        },
        meta: {
            ...clone.meta,
            configHash: clone.meta.configHash ?? canonicalHash,
        },
    };
    return deepFreeze(normalized);
}
/**
 * Safe fallback resolver that checks candidate payload and returns structured status.
 */
export function validateOrFallback(payload, fallback = DEFAULT_REMOTE_CONFIG) {
    const result = validateRemoteConfig(payload);
    if (!result.valid) {
        return {
            config: deepFreeze(structuredClone(fallback)),
            valid: false,
            errors: result.errors,
            usedFallback: true,
        };
    }
    return {
        config: normalizeRemoteConfig(payload, fallback),
        valid: true,
        errors: [],
        usedFallback: false,
    };
}
// ─── Section Validators ─────────────────────────────────────────────────────
function validateIdentity(value, errors) {
    if (!section(value, 'sdk', errors))
        return;
    nonEmptyString(value, 'projectId', 'sdk.projectId', errors);
    optionalNonEmptyString(value, 'service', 'sdk.service', errors);
    nonEmptyString(value, 'environment', 'sdk.environment', errors);
    nonEmptyString(value, 'release', 'sdk.release', errors);
}
function validateSampling(value, errors) {
    if (!section(value, 'sampling', errors))
        return;
    for (const key of SAMPLING_KEYS)
        probability(value, key, `sampling.${key}`, errors);
    const routes = value['routes'];
    if (!isRecord(routes)) {
        errors.push('sampling.routes is missing or not an object');
        return;
    }
    for (const [prefix, rates] of Object.entries(routes)) {
        if (!prefix || prefix.trim().length === 0) {
            errors.push('sampling.routes contains an empty route prefix');
        }
        if (!isRecord(rates)) {
            errors.push(`sampling.routes.${prefix} is not an object`);
            continue;
        }
        for (const [key, rate] of Object.entries(rates)) {
            if (!SAMPLING_KEYS.includes(key)) {
                errors.push(`sampling.routes.${prefix}.${key} is not a supported sampling family`);
            }
            else if (!isProbability(rate)) {
                errors.push(`sampling.routes.${prefix}.${key} is not a number in [0, 1]`);
            }
        }
    }
}
function validateInstrumentation(value, errors) {
    if (!section(value, 'instrumentation', errors))
        return;
    for (const key of ['http', 'https', 'fetch', 'axios', 'mongodb', 'eventEmitterPatch']) {
        boolean(value, key, `instrumentation.${key}`, errors);
    }
    booleanOrObject(value, 'redis', ['enabled'], errors);
    if (isRecord(value['redis']) && value['redis']['keyPolicy'] !== undefined) {
        const kp = String(value['redis']['keyPolicy']);
        if (!['command-only', 'sanitized-key', 'full', 'hash'].includes(kp)) {
            errors.push('instrumentation.redis.keyPolicy is invalid');
        }
    }
    booleanOrObject(value, 'express', ['enabled'], errors);
    booleanOrObject(value, 'fastify', ['enabled', 'captureHooks', 'captureValidationErrors'], errors);
    booleanOrObject(value, 'graphql', ['enabled', 'captureResolvers'], errors);
    booleanOrObject(value, 'prisma', ['enabled', 'captureQueries', 'captureParams'], errors);
    booleanOrObject(value, 'pg', ['enabled', 'captureQueries', 'captureParams'], errors);
    booleanOrObject(value, 'mysql2', ['enabled', 'captureQueries'], errors);
    booleanOrObject(value, 'bullmq', ['enabled'], errors, [
        'emitCreateSpansForBulk', 'emitCreateSpansForFlow', 'requireParentSpanForPublish',
    ]);
}
function validatePrivacy(value, errors) {
    if (!section(value, 'privacy', errors))
        return;
    const capture = value['capture'];
    if (section(capture, 'privacy.capture', errors)) {
        for (const key of ['headers', 'body', 'response', 'query', 'cookies']) {
            boolean(capture, key, `privacy.capture.${key}`, errors);
        }
    }
    const scrubbing = value['scrubbing'];
    if (section(scrubbing, 'privacy.scrubbing', errors)) {
        boolean(scrubbing, 'enabled', 'privacy.scrubbing.enabled', errors);
        stringArray(scrubbing, 'headers', 'privacy.scrubbing.headers', errors);
        stringArray(scrubbing, 'fields', 'privacy.scrubbing.fields', errors);
    }
    const pii = value['piiDetection'];
    if (section(pii, 'privacy.piiDetection', errors)) {
        for (const key of ['enabled', 'maskEmails', 'maskPhones', 'maskIPs']) {
            boolean(pii, key, `privacy.piiDetection.${key}`, errors);
        }
        if ('maskCreditCards' in pii)
            boolean(pii, 'maskCreditCards', 'privacy.piiDetection.maskCreditCards', errors);
        if ('maskSSNs' in pii)
            boolean(pii, 'maskSSNs', 'privacy.piiDetection.maskSSNs', errors);
    }
}
function validateLimits(value, errors) {
    if (!section(value, 'limits', errors))
        return;
    integer(value, 'maxSpansPerTrace', errors, SAFETY_CEILINGS.minSpansPerTrace, SAFETY_CEILINGS.maxSpansPerTrace, 'limits');
    integer(value, 'maxSpanAttributes', errors, SAFETY_CEILINGS.minSpanAttributes, SAFETY_CEILINGS.maxSpanAttributes, 'limits');
    integer(value, 'maxAttributeLength', errors, SAFETY_CEILINGS.minAttributeLength, SAFETY_CEILINGS.maxAttributeLength, 'limits');
    integer(value, 'maxPayloadSize', errors, SAFETY_CEILINGS.minPayloadSize, SAFETY_CEILINGS.maxPayloadSize, 'limits');
    integer(value, 'maxQueueSize', errors, SAFETY_CEILINGS.minQueueSize, SAFETY_CEILINGS.maxQueueSize, 'limits');
    memoryLimit(value, 'maxMemoryMb', errors);
    if ('maxCpuOverheadPercent' in value) {
        errors.push('limits.maxCpuOverheadPercent is no longer supported because the client cannot enforce it');
    }
    const tenant = value['tenantGovernance'];
    if (section(tenant, 'limits.tenantGovernance', errors)) {
        boolean(tenant, 'enabled', 'limits.tenantGovernance.enabled', errors);
        integer(tenant, 'maxTenantsTracked', errors, SAFETY_CEILINGS.minTenantsTracked, SAFETY_CEILINGS.maxTenantsTracked, 'limits.tenantGovernance');
        integer(tenant, 'quotaPerWindow', errors, SAFETY_CEILINGS.minQuotaPerWindow, SAFETY_CEILINGS.quotaPerWindow, 'limits.tenantGovernance');
        integer(tenant, 'windowDurationMs', errors, SAFETY_CEILINGS.minWindowDurationMs, SAFETY_CEILINGS.windowDurationMs, 'limits.tenantGovernance');
        integer(tenant, 'criticalReserve', errors, SAFETY_CEILINGS.minCriticalReserve, SAFETY_CEILINGS.criticalReserve, 'limits.tenantGovernance');
    }
    const persistence = value['persistenceGovernance'];
    if (section(persistence, 'limits.persistenceGovernance', errors)) {
        integer(persistence, 'maxPersistPerMinute', errors, SAFETY_CEILINGS.minPersistPerMinute, SAFETY_CEILINGS.maxPersistPerMinute, 'limits.persistenceGovernance');
        boolean(persistence, 'adaptive', 'limits.persistenceGovernance.adaptive', errors);
        integer(persistence, 'budgetExceededLogIntervalMs', errors, SAFETY_CEILINGS.minBudgetExceededLogIntervalMs, SAFETY_CEILINGS.maxBudgetExceededLogIntervalMs, 'limits.persistenceGovernance');
    }
}
function validateTransport(value, errors) {
    if (!section(value, 'transport', errors))
        return;
    const retry = value['retry'];
    if (section(retry, 'transport.retry', errors)) {
        boolean(retry, 'enabled', 'transport.retry.enabled', errors);
        integer(retry, 'maxRetries', errors, SAFETY_CEILINGS.minRetryMaxRetries, SAFETY_CEILINGS.retryMaxRetries, 'transport.retry');
        if (!['exponential', 'linear', 'fixed'].includes(String(retry['backoff']))) {
            errors.push('transport.retry.backoff is invalid');
        }
        integer(retry, 'baseDelayMs', errors, SAFETY_CEILINGS.minRetryBaseDelayMs, SAFETY_CEILINGS.retryBaseDelayMs, 'transport.retry');
    }
    const queue = value['queue'];
    if (section(queue, 'transport.queue', errors)) {
        if (queue['overflowStrategy'] !== 'drop_oldest' && queue['overflowStrategy'] !== 'drop_newest') {
            errors.push('transport.queue.overflowStrategy is invalid');
        }
        integer(queue, 'maxSize', errors, SAFETY_CEILINGS.minQueueSize, SAFETY_CEILINGS.maxQueueSize, 'transport.queue');
        integer(queue, 'criticalReserve', errors, 0, SAFETY_CEILINGS.maxQueueSize, 'transport.queue');
        if (Number.isInteger(queue['maxSize']) && Number.isInteger(queue['criticalReserve'])
            && queue['criticalReserve'] > queue['maxSize']) {
            errors.push('transport.queue.criticalReserve cannot exceed transport.queue.maxSize');
        }
    }
    boolean(value, 'keepAlive', 'transport.keepAlive', errors);
    const connections = value['connections'];
    if (section(connections, 'transport.connections', errors)) {
        integer(connections, 'maxTotalConnections', errors, SAFETY_CEILINGS.minTotalConnections, SAFETY_CEILINGS.maxTotalConnections, 'transport.connections');
        integer(connections, 'acquireTimeoutMs', errors, SAFETY_CEILINGS.minAcquireTimeoutMs, SAFETY_CEILINGS.acquireTimeoutMs, 'transport.connections');
        if (connections['maxConnectionsPerRoute'] !== undefined) {
            const perRoute = connections['maxConnectionsPerRoute'];
            if (!isRecord(perRoute)) {
                errors.push('transport.connections.maxConnectionsPerRoute is not an object');
            }
            else {
                for (const [route, count] of Object.entries(perRoute)) {
                    if (!REQUIRED_ROUTES.includes(route)) {
                        errors.push(`transport.connections.maxConnectionsPerRoute.${route} is not a supported route`);
                    }
                    else if (!Number.isInteger(count) || count < SAFETY_CEILINGS.minConnectionsPerRoute || count > SAFETY_CEILINGS.maxConnectionsPerRoute) {
                        errors.push(`transport.connections.maxConnectionsPerRoute.${route} is invalid`);
                    }
                }
            }
        }
    }
    const routes = value['routes'];
    if (!isRecord(routes)) {
        errors.push('transport.routes is missing or not an object');
        return;
    }
    for (const name of REQUIRED_ROUTES) {
        const route = routes[name];
        if (!isRecord(route)) {
            errors.push(`transport.routes.${name} is missing or not an object`);
            continue;
        }
        if (typeof route['url'] !== 'string' || !isAllowedTransportUrl(route['url'])) {
            errors.push(`transport.routes.${name}.url is missing or not an allowed HTTP(S) URL`);
        }
        integer(route, 'batchSize', errors, SAFETY_CEILINGS.minBatchSize, SAFETY_CEILINGS.batchSize, `transport.routes.${name}`);
        integer(route, 'flushIntervalMs', errors, SAFETY_CEILINGS.minFlushIntervalMs, SAFETY_CEILINGS.flushIntervalMs, `transport.routes.${name}`);
        integer(route, 'timeoutMs', errors, SAFETY_CEILINGS.minTimeoutMs, SAFETY_CEILINGS.timeoutMs, `transport.routes.${name}`);
        if (route['compression'] !== 'gzip' && route['compression'] !== 'none') {
            errors.push(`transport.routes.${name}.compression is invalid`);
        }
        if (!['critical', 'high', 'normal', 'low'].includes(String(route['priority']))) {
            errors.push(`transport.routes.${name}.priority is invalid`);
        }
    }
}
function validateOfflineQueue(value, errors) {
    if (!section(value, 'offlineQueue', errors))
        return;
    boolean(value, 'enabled', 'offlineQueue.enabled', errors);
    integer(value, 'maxFileSizeBytes', errors, SAFETY_CEILINGS.offlineQueueMinFileSizeBytes, SAFETY_CEILINGS.offlineQueueMaxFileSizeBytes, 'offlineQueue');
    integer(value, 'maxEvents', errors, SAFETY_CEILINGS.offlineQueueMinEvents, SAFETY_CEILINGS.offlineQueueMaxEvents, 'offlineQueue');
    integer(value, 'eventTtlMs', errors, SAFETY_CEILINGS.offlineQueueMinEventTtlMs, SAFETY_CEILINGS.offlineQueueEventTtlMs, 'offlineQueue');
    integer(value, 'ioTimeoutMs', errors, SAFETY_CEILINGS.offlineQueueMinIoTimeoutMs, SAFETY_CEILINGS.offlineQueueIoTimeoutMs, 'offlineQueue');
    if (value['flushDebounceMs'] !== undefined) {
        integer(value, 'flushDebounceMs', errors, 0, 60_000, 'offlineQueue');
    }
}
function validateProfiling(value, errors) {
    if (!section(value, 'profiling', errors))
        return;
    boolean(value, 'enabled', 'profiling.enabled', errors);
    boolean(value, 'cpu', 'profiling.cpu', errors);
    boolean(value, 'heap', 'profiling.heap', errors);
    probability(value, 'sampleRate', 'profiling.sampleRate', errors);
    integer(value, 'maxDurationMs', errors, SAFETY_CEILINGS.minProfileDurationMs, SAFETY_CEILINGS.profileMaxDurationMs, 'profiling');
    if (value['sampleIntervalMicroseconds'] !== undefined) {
        integer(value, 'sampleIntervalMicroseconds', errors, 1, 1_000_000, 'profiling');
    }
}
function validateReplay(value, errors) {
    if (!section(value, 'replay', errors))
        return;
    boolean(value, 'enabled', 'replay.enabled', errors);
    probability(value, 'sampleRate', 'replay.sampleRate', errors);
    integer(value, 'idleTimeoutMs', errors, 1_000, 24 * 60 * 60 * 1_000, 'replay');
    integer(value, 'maxDurationMs', errors, SAFETY_CEILINGS.minReplayDurationMs, SAFETY_CEILINGS.replayMaxDurationMs, 'replay');
    if (value['maxBufferSize'] !== undefined) {
        integer(value, 'maxBufferSize', errors, 1, 100_000, 'replay');
    }
    if (value['maskAllInputs'] !== undefined) {
        boolean(value, 'maskAllInputs', 'replay.maskAllInputs', errors);
    }
}
function validateErrors(value, errors) {
    if (!section(value, 'errors', errors))
        return;
    boolean(value, 'captureUnhandledRejections', 'errors.captureUnhandledRejections', errors);
    boolean(value, 'captureUncaughtExceptions', 'errors.captureUncaughtExceptions', errors);
    boolean(value, 'captureConsoleErrors', 'errors.captureConsoleErrors', errors);
    integer(value, 'stackTraceLimit', errors, SAFETY_CEILINGS.minStackTraceLimit, SAFETY_CEILINGS.stackTraceLimit, 'errors');
    boolean(value, 'attachSourceContext', 'errors.attachSourceContext', errors);
    const grouping = value['grouping'];
    if (section(grouping, 'errors.grouping', errors)) {
        boolean(grouping, 'enabled', 'errors.grouping.enabled', errors);
        boolean(grouping, 'normalizePaths', 'errors.grouping.normalizePaths', errors);
    }
}
function validateTracing(value, errors) {
    if (!section(value, 'tracing', errors))
        return;
    integer(value, 'maxSpansPerTrace', errors, SAFETY_CEILINGS.minSpansPerTrace, SAFETY_CEILINGS.maxSpansPerTrace, 'tracing');
    integer(value, 'maxSpanAttributes', errors, SAFETY_CEILINGS.minSpanAttributes, SAFETY_CEILINGS.maxSpanAttributes, 'tracing');
    integer(value, 'maxTraceDurationMs', errors, SAFETY_CEILINGS.minTraceDurationMs, SAFETY_CEILINGS.maxTraceDurationMs, 'tracing');
    const propagation = value['propagation'];
    if (section(propagation, 'tracing.propagation', errors)) {
        boolean(propagation, 'w3c', 'tracing.propagation.w3c', errors);
        boolean(propagation, 'baggage', 'tracing.propagation.baggage', errors);
        boolean(propagation, 'b3', 'tracing.propagation.b3', errors);
    }
}
function validateMetrics(value, errors) {
    if (!section(value, 'metrics', errors))
        return;
    boolean(value, 'runtimeMetrics', 'metrics.runtimeMetrics', errors);
    boolean(value, 'eventLoopMonitoring', 'metrics.eventLoopMonitoring', errors);
    boolean(value, 'gcMonitoring', 'metrics.gcMonitoring', errors);
    integer(value, 'pushIntervalMs', errors, 1_000, 5 * 60 * 1_000, 'metrics');
    integer(value, 'cardinalityLimit', errors, 10, 100_000, 'metrics');
}
function validateLogs(value, errors) {
    if (!section(value, 'logs', errors))
        return;
    boolean(value, 'enabled', 'logs.enabled', errors);
    boolean(value, 'captureConsole', 'logs.captureConsole', errors);
    stringArray(value, 'levels', 'logs.levels', errors);
    integer(value, 'maxLogSize', errors, SAFETY_CEILINGS.minLogSize, SAFETY_CEILINGS.maxLogSize, 'logs');
}
function validateCrons(value, errors) {
    if (!section(value, 'crons', errors))
        return;
    boolean(value, 'enabled', 'crons.enabled', errors);
    integer(value, 'checkInMarginMs', errors, 1_000, 60 * 60 * 1_000, 'crons');
    integer(value, 'timeoutMs', errors, 1_000, 24 * 60 * 60 * 1_000, 'crons');
}
function validateCrossSectionInvariants(config, errors) {
    const limits = config['limits'];
    const transport = config['transport'];
    if (!isRecord(limits) || !isRecord(transport) || !isRecord(transport['queue']))
        return;
    const maxQueueSize = limits['maxQueueSize'];
    const routeQueueSize = transport['queue']['maxSize'];
    if (Number.isInteger(maxQueueSize) && Number.isInteger(routeQueueSize)
        && routeQueueSize > maxQueueSize) {
        errors.push('transport.queue.maxSize cannot exceed limits.maxQueueSize');
    }
}
function validateMeta(value, errors) {
    if (!section(value, 'meta', errors))
        return;
    nonEmptyString(value, 'generatedAt', 'meta.generatedAt', errors);
    if (typeof value['generatedAt'] === 'string' && Number.isNaN(Date.parse(value['generatedAt']))) {
        errors.push('meta.generatedAt is not a valid date');
    }
    nonEmptyString(value, 'generatedBy', 'meta.generatedBy', errors);
    optionalNonEmptyString(value, 'configHash', 'meta.configHash', errors);
    if ('configRevision' in value) {
        const rev = value['configRevision'];
        if (rev !== undefined && rev !== null && (typeof rev !== 'number' || !Number.isInteger(rev))) {
            errors.push('meta.configRevision must be an integer or null');
        }
    }
}
function validateBooleanSection(value, name, keys, errors) {
    if (!section(value, name, errors))
        return;
    for (const key of keys)
        boolean(value, key, `${name}.${key}`, errors);
}
function booleanOrObject(value, key, requiredBooleanKeys, errors, optionalBooleanKeys = []) {
    const candidate = value[key];
    if (typeof candidate === 'boolean')
        return;
    if (!isRecord(candidate)) {
        errors.push(`instrumentation.${key} is not a boolean or object`);
        return;
    }
    for (const nested of requiredBooleanKeys)
        boolean(candidate, nested, `instrumentation.${key}.${nested}`, errors);
    for (const nested of optionalBooleanKeys) {
        if (candidate[nested] !== undefined)
            boolean(candidate, nested, `instrumentation.${key}.${nested}`, errors);
    }
}
function section(value, name, errors) {
    if (!isRecord(value)) {
        errors.push(`${name} is missing or not an object`);
        return false;
    }
    return true;
}
function boolean(value, key, path, errors) {
    if (typeof value[key] !== 'boolean')
        errors.push(`${path} is missing or not a boolean`);
}
function probability(value, key, path, errors) {
    if (!isProbability(value[key]))
        errors.push(`${path} is not a number in [0, 1]`);
}
function integer(value, key, errors, min, max, prefix = '') {
    const candidate = value[key];
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof candidate !== 'number' || !Number.isInteger(candidate) || candidate < min || candidate > max) {
        errors.push(`${path} is missing or outside [${min}, ${max}]`);
    }
}
function memoryLimit(value, key, errors) {
    const candidate = value[key];
    if (candidate === 'auto')
        return;
    if (typeof candidate !== 'number' || !Number.isFinite(candidate) || candidate < SAFETY_CEILINGS.minMemoryMb || candidate > SAFETY_CEILINGS.maxMemoryMb) {
        errors.push(`limits.${key} must be "auto" or a number in [${SAFETY_CEILINGS.minMemoryMb}, ${SAFETY_CEILINGS.maxMemoryMb}]`);
    }
}
function nonEmptyString(value, key, path, errors) {
    if (typeof value[key] !== 'string' || value[key].trim().length === 0)
        errors.push(`${path} is missing or empty`);
}
function optionalNonEmptyString(value, key, path, errors) {
    if (value[key] !== undefined && (typeof value[key] !== 'string' || value[key].trim().length === 0)) {
        errors.push(`${path} is empty or not a string`);
    }
}
function stringArray(value, key, path, errors) {
    const candidate = value[key];
    if (!Array.isArray(candidate) || candidate.some(item => typeof item !== 'string' || item.length === 0)) {
        errors.push(`${path} is missing or not an array of non-empty strings`);
    }
}
function isAllowedTransportUrl(value) {
    try {
        const url = new URL(value);
        if (url.username || url.password || url.hash)
            return false;
        if (url.protocol === 'https:')
            return true;
        return url.protocol === 'http:' && ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname);
    }
    catch {
        return false;
    }
}
function isProbability(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}
function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function invalid(message) {
    return { valid: false, errors: [message] };
}
function stableStringify(obj) {
    if (obj === null || typeof obj !== 'object') {
        return JSON.stringify(obj);
    }
    if (Array.isArray(obj)) {
        return `[${obj.map(stableStringify).join(',')}]`;
    }
    const record = obj;
    const sortedKeys = Object.keys(record).sort();
    const entries = sortedKeys.map(key => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
    return `{${entries.join(',')}}`;
}
