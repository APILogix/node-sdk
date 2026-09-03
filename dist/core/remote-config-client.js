import { context } from '@opentelemetry/api';
import { suppressTracing } from '@opentelemetry/core';
import { resolveApiBaseUrl } from '../constants/defaults.js';
import { SDKError, toError } from './errors.js';
import { validateApiKey } from './api-key.js';
import { getLogger } from '../utils/logger.js';
const CONTROL_PLANE_TIMEOUT_MS = 5_000;
const CONTROL_PLANE_PATH_PREFIX = '';
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
        this.baseUrl = normalizeBaseUrl(resolveApiBaseUrl());
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
        getLogger().info('[RemoteConfigClient] Init response accepted', {
            endpoint: '/v1/init',
            success: normalized.success,
            projectId: normalized.projectId,
            organizationId: normalized.organizationId,
            environmentId: normalized.environmentId,
            environment: normalized.environment,
            release: normalized.release,
            configRevision: normalized.configRevision,
            configHash: normalized.configHash,
        });
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
            const startedAt = Date.now();
            getLogger().info('[RemoteConfigClient] Control-plane request started', {
                endpoint: `${CONTROL_PLANE_PATH_PREFIX}${path}`,
                url,
                method: 'POST',
            });
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
            const latencyMs = Date.now() - startedAt;
            const text = await response.text();
            getLogger().info('[RemoteConfigClient] Control-plane response received', {
                endpoint: `${CONTROL_PLANE_PATH_PREFIX}${path}`,
                statusCode: response.status,
                ok: response.ok,
                latencyMs,
                responseBytes: Buffer.byteLength(text),
                contentType: response.headers.get('content-type') ?? undefined,
            });
            let payload = null;
            if (text) {
                try {
                    payload = JSON.parse(text);
                }
                catch (error) {
                    throw new SDKError('Control-plane response was not valid JSON', 'INVALID_JSON', {
                        statusCode: response.status,
                    }, error);
                }
            }
            if (path === '/v1/init') {
                getLogger().info('[RemoteConfigClient] Init route response served', summarizeInitRoutePayload(payload));
            }
            if (!response.ok) {
                throw new SDKError('Control-plane request failed', 'HTTP_ERROR', {
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
                reason: normalized.name === 'AbortError' ? 'timeout' : normalized.message,
            }, normalized);
        }
        finally {
            clearTimeout(timer);
        }
    }
}
function summarizeInitRoutePayload(payload) {
    const summary = {
        endpoint: '/v1/init',
        responseType: payload === null ? 'null' : Array.isArray(payload) ? 'array' : typeof payload,
    };
    if (!isRecord(payload))
        return summary;
    const config = isRecord(payload['config']) ? payload['config'] : undefined;
    const sdk = config && isRecord(config['sdk']) ? config['sdk'] : undefined;
    const meta = config && isRecord(config['meta']) ? config['meta'] : undefined;
    return {
        ...summary,
        success: payload['success'],
        projectId: payload['projectId'] ?? sdk?.['projectId'],
        organizationId: payload['organizationId'],
        environmentId: payload['environmentId'],
        environment: payload['environment'] ?? sdk?.['environment'],
        release: payload['release'] ?? sdk?.['release'],
        configRevision: payload['configRevision'],
        configHash: payload['configHash'] ?? meta?.['configHash'],
        configSections: config ? Object.keys(config).sort() : undefined,
    };
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
    const projectId = isNonEmptyString(payload['projectId']) ? payload['projectId'] : null;
    const environment = isNonEmptyString(payload['environment']) ? payload['environment'] : null;
    const release = isNonEmptyString(payload['release']) ? payload['release'] : null;
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
