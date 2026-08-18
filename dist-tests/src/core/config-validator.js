import { REMOTE_CONFIG_SCHEMA_VERSION } from '../types/config.js';
import { SAFETY_CEILINGS } from '../constants/defaults.js';
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
 * Validate a complete replacement snapshot. No defaults, deep merges, or
 * partial patches are accepted: either every subsystem can consume the
 * document or the entire document is rejected.
 */
export function validateRemoteConfig(payload) {
    const errors = [];
    if (!isRecord(payload))
        return invalid('payload is not a JSON object');
    const config = payload;
    integer(config, 'schemaVersion', errors, 1, REMOTE_CONFIG_SCHEMA_VERSION);
    if (typeof config['schemaVersion'] === 'number' && config['schemaVersion'] > REMOTE_CONFIG_SCHEMA_VERSION) {
        errors.push(`schemaVersion ${config['schemaVersion']} is newer than SDK-supported ${REMOTE_CONFIG_SCHEMA_VERSION}; SDK upgrade required`);
    }
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
        if (!prefix)
            errors.push('sampling.routes contains an empty route prefix');
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
    for (const key of ['http', 'https', 'fetch', 'axios', 'mongodb', 'redis', 'eventEmitterPatch']) {
        boolean(value, key, `instrumentation.${key}`, errors);
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
    }
}
function validateLimits(value, errors) {
    if (!section(value, 'limits', errors))
        return;
    integer(value, 'maxSpansPerTrace', errors, 1, SAFETY_CEILINGS.maxSpansPerTrace, 'limits');
    integer(value, 'maxSpanAttributes', errors, 1, SAFETY_CEILINGS.maxSpanAttributes, 'limits');
    integer(value, 'maxAttributeLength', errors, 1, SAFETY_CEILINGS.maxAttributeLength, 'limits');
    integer(value, 'maxPayloadSize', errors, 1_024, SAFETY_CEILINGS.maxPayloadSize, 'limits');
    integer(value, 'maxQueueSize', errors, 1, SAFETY_CEILINGS.maxQueueSize, 'limits');
    memoryLimit(value, 'maxMemoryMb', errors);
    if ('maxCpuOverheadPercent' in value) {
        errors.push('limits.maxCpuOverheadPercent is no longer supported because the SDK cannot enforce it');
    }
    const tenant = value['tenantGovernance'];
    if (section(tenant, 'limits.tenantGovernance', errors)) {
        boolean(tenant, 'enabled', 'limits.tenantGovernance.enabled', errors);
        integer(tenant, 'maxTenantsTracked', errors, 1, 100_000, 'limits.tenantGovernance');
        integer(tenant, 'quotaPerWindow', errors, 1, 1_000_000, 'limits.tenantGovernance');
        integer(tenant, 'windowDurationMs', errors, 1_000, 3_600_000, 'limits.tenantGovernance');
        integer(tenant, 'criticalReserve', errors, 0, 100_000, 'limits.tenantGovernance');
    }
}
function validateTransport(value, errors) {
    if (!section(value, 'transport', errors))
        return;
    const retry = value['retry'];
    if (section(retry, 'transport.retry', errors)) {
        boolean(retry, 'enabled', 'transport.retry.enabled', errors);
        integer(retry, 'maxRetries', errors, 0, SAFETY_CEILINGS.retryMaxRetries, 'transport.retry');
        if (!['exponential', 'linear', 'fixed'].includes(String(retry['backoff']))) {
            errors.push('transport.retry.backoff is invalid');
        }
        integer(retry, 'baseDelayMs', errors, 0, SAFETY_CEILINGS.retryBaseDelayMs, 'transport.retry');
    }
    const queue = value['queue'];
    if (section(queue, 'transport.queue', errors)) {
        if (queue['overflowStrategy'] !== 'drop_oldest' && queue['overflowStrategy'] !== 'drop_newest') {
            errors.push('transport.queue.overflowStrategy is invalid');
        }
        integer(queue, 'maxSize', errors, 1, SAFETY_CEILINGS.maxQueueSize, 'transport.queue');
        integer(queue, 'criticalReserve', errors, 0, SAFETY_CEILINGS.maxQueueSize, 'transport.queue');
        if (Number.isInteger(queue['maxSize']) && Number.isInteger(queue['criticalReserve'])
            && queue['criticalReserve'] > queue['maxSize']) {
            errors.push('transport.queue.criticalReserve cannot exceed transport.queue.maxSize');
        }
    }
    boolean(value, 'keepAlive', 'transport.keepAlive', errors);
    const connections = value['connections'];
    if (section(connections, 'transport.connections', errors)) {
        integer(connections, 'maxTotalConnections', errors, 1, 500, 'transport.connections');
        integer(connections, 'acquireTimeoutMs', errors, 100, 60_000, 'transport.connections');
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
                    else if (!Number.isInteger(count) || count < 1 || count > 100) {
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
        integer(route, 'batchSize', errors, 1, SAFETY_CEILINGS.batchSize, `transport.routes.${name}`);
        integer(route, 'flushIntervalMs', errors, 0, SAFETY_CEILINGS.flushIntervalMs, `transport.routes.${name}`);
        integer(route, 'timeoutMs', errors, 250, SAFETY_CEILINGS.timeoutMs, `transport.routes.${name}`);
        if (route['compression'] !== 'gzip' && route['compression'] !== 'none') {
            errors.push(`transport.routes.${name}.compression is invalid`);
        }
        if (!['critical', 'high', 'normal', 'low'].includes(String(route['priority']))) {
            errors.push(`transport.routes.${name}.priority is invalid`);
        }
    }
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
function finiteNumber(value, key, errors, min, max, prefix) {
    const candidate = value[key];
    if (typeof candidate !== 'number' || !Number.isFinite(candidate) || candidate < min || candidate > max) {
        errors.push(`${prefix}.${key} is missing or outside [${min}, ${max}]`);
    }
}
function memoryLimit(value, key, errors) {
    const candidate = value[key];
    if (candidate === 'auto')
        return;
    if (typeof candidate !== 'number' || !Number.isFinite(candidate) || candidate < 1 || candidate > SAFETY_CEILINGS.maxMemoryMb) {
        errors.push(`limits.${key} must be "auto" or a number in [1, ${SAFETY_CEILINGS.maxMemoryMb}]`);
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
