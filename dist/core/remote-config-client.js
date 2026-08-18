import { context } from '@opentelemetry/api';
import { suppressTracing } from '@opentelemetry/core';
import { resolveApiBaseUrl } from '../constants/defaults.js';
import { SDKError, toError } from './errors.js';
import { validateApiKey } from './api-key.js';
const CONTROL_PLANE_TIMEOUT_MS = 5_000;
const CONTROL_PLANE_PATH_PREFIX = '/api';
/**
 * The SDK's sole control-plane network client.
 *
 * It intentionally knows only two operations. Neither operation retries or
 * polls; callers decide when a request is allowed.
 */
export class RemoteConfigClient {
    apiKey;
    baseUrl;
    timeoutMs;
    fetchImpl;
    constructor(options) {
        validateApiKey(options.apiKey);
        this.apiKey = options.apiKey;
        this.baseUrl = normalizeBaseUrl(resolveApiBaseUrl(options.baseUrl));
        this.timeoutMs = options.timeoutMs ?? CONTROL_PLANE_TIMEOUT_MS;
        this.fetchImpl = options.fetchImpl ?? fetch;
    }
    /** Perform the one and only startup request. */
    async initialize() {
        const payload = await this.post('/v1/init');
        const normalized = normalizeInitResponse(payload);
        if (!normalized) {
            throw new SDKError('Init response is missing project, environment, release, or complete configuration', 'INVALID_INIT_RESPONSE');
        }
        const sdk = normalized.config.sdk;
        if (!isRecord(sdk)
            || normalized.projectId !== sdk['projectId']
            || normalized.environment !== sdk['environment']
            || normalized.release !== sdk['release']) {
            throw new SDKError('Init response identity does not match config.sdk', 'INVALID_INIT_RESPONSE');
        }
        return normalized;
    }
    /** Download a complete replacement snapshot after a telemetry change signal. */
    async fetchLatest() {
        const payload = await this.post('/v1/sdk-config');
        // Accept either a direct config document or a small { config } envelope.
        // No partial/patch form is supported.
        if (isRecord(payload) && 'config' in payload)
            return payload['config'];
        return payload;
    }
    async post(path) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        timer.unref?.();
        const url = `${this.baseUrl}${CONTROL_PLANE_PATH_PREFIX}${path}`;
        try {
            // Application metadata, capabilities, versions, and local overrides are
            // not configuration inputs; the backend resolves all policy from the API key.
            const response = await context.with(suppressTracing(context.active()), () => this.fetchImpl(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-pulse-internal': '1',
                    'X-API-Key': this.apiKey,
                },
                body: JSON.stringify({}),
                signal: controller.signal,
                redirect: 'manual',
            }));
            const text = await response.text();
            let payload = null;
            if (text) {
                try {
                    payload = JSON.parse(text);
                }
                catch (error) {
                    throw new SDKError('Control-plane response was not valid JSON', 'INVALID_JSON', {
                        endpoint: url,
                        statusCode: response.status,
                    }, error);
                }
            }
            console.log('[Pulse] control-plane response', {
                endpoint: url,
                statusCode: response.status,
                body: payload,
            });
            if (!response.ok) {
                throw new SDKError('Control-plane request failed', 'HTTP_ERROR', {
                    endpoint: url,
                    statusCode: response.status,
                    status: response.status,
                });
            }
            return payload;
        }
        catch (error) {
            if (error instanceof SDKError)
                throw error;
            const normalized = toError(error);
            throw new SDKError('Control-plane request failed', 'NETWORK_ERROR', {
                endpoint: url,
                reason: normalized.name === 'AbortError' ? 'timeout' : normalized.message,
            }, normalized);
        }
        finally {
            clearTimeout(timer);
        }
    }
}
function normalizeBaseUrl(value) {
    try {
        const url = new URL(value);
        if (url.protocol !== 'https:' && url.protocol !== 'http:') {
            throw new Error('unsupported protocol');
        }
        if (url.username || url.password || url.search || url.hash || (url.pathname && url.pathname !== '/')) {
            throw new Error('base URL must be an origin');
        }
        return url.origin;
    }
    catch (error) {
        throw new SDKError('baseUrl must be an HTTP(S) origin', 'INVALID_URL', { baseUrl: value }, error);
    }
}
function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function normalizeInitResponse(payload) {
    if (!isRecord(payload))
        return null;
    const config = extractInitConfig(payload);
    if (!isRecord(config) || !isRecord(config['sdk']))
        return null;
    const sdk = config['sdk'];
    const meta = isRecord(config['meta']) ? config['meta'] : null;
    const projectId = firstNonEmptyString(payload['projectId'], sdk['projectId']);
    const environment = firstNonEmptyString(payload['environment'], sdk['environment']);
    const release = firstNonEmptyString(payload['release'], sdk['release']);
    if (!projectId || !environment || !release)
        return null;
    return {
        success: payload['success'] === undefined ? true : payload['success'] === true,
        projectId,
        ...(isNonEmptyString(payload['organizationId']) ? { organizationId: payload['organizationId'] } : {}),
        ...(isNonEmptyString(payload['environmentId']) ? { environmentId: payload['environmentId'] } : {}),
        environment,
        release,
        ...(isRecord(payload['project']) ? { project: payload['project'] } : {}),
        ...(typeof payload['configRevision'] === 'number' || payload['configRevision'] === null
            ? { configRevision: payload['configRevision'] }
            : {}),
        ...(isNonEmptyString(meta?.['configHash']) ? { configHash: meta['configHash'] } : {}),
        config: config,
    };
}
function extractInitConfig(payload) {
    if (isRecord(payload['config']))
        return payload['config'];
    if (isRecord(payload['body']))
        return payload['body'];
    if (isRecord(payload['data']))
        return payload['data'];
    if (isRecord(payload['sdk']))
        return payload;
    return null;
}
function firstNonEmptyString(...values) {
    for (const value of values) {
        if (isNonEmptyString(value))
            return value;
    }
    return null;
}
function isNonEmptyString(value) {
    return typeof value === 'string' && value.trim().length > 0;
}
//# sourceMappingURL=remote-config-client.js.map