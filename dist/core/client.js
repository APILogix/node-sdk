import { createHash } from 'crypto';
import { RingBuffer } from './ring-buffer.js';
import { SDKError } from './errors.js';
import { SDK_NAME, SDK_VERSION } from '../constants/version.js';
class SDKClient {
    static instance;
    // ─── State ──────────────────────────────────────────────────────────────
    configValue = null;
    remoteConfigValue = null;
    initResponseValue = null;
    initPromise = null;
    apiKeyValue = null;
    initIdentityValue = null;
    pendingInitIdentityValue = null;
    optionsValue = null;
    // ─── Plugin System ────────────────────────────────────────────────────
    pluginRegistry = [];
    eventProcessorRegistry = [];
    // ─── Metadata ─────────────────────────────────────────────────────────
    metadataValue = {
        sdkName: SDK_NAME,
        sdkVersion: SDK_VERSION,
        service: 'unknown-service',
        environment: 'production',
        release: '0.0.0-unknown',
    };
    // ─── Breadcrumbs ──────────────────────────────────────────────────────
    breadcrumbBuffer = new RingBuffer(100);
    constructor() { }
    static getInstance() {
        if (!SDKClient.instance) {
            SDKClient.instance = new SDKClient();
        }
        return SDKClient.instance;
    }
    // ─── Initialization State ─────────────────────────────────────────────
    get initialized() {
        return this.configValue !== null;
    }
    get config() {
        if (!this.configValue) {
            throw new SDKError('SDK not initialized', 'SDK_NOT_INITIALIZED');
        }
        return this.configValue;
    }
    get remoteConfig() {
        return this.remoteConfigValue;
    }
    get initResponse() {
        return this.initResponseValue;
    }
    get projectId() {
        return this.initResponseValue?.projectId ?? null;
    }
    get options() {
        return this.optionsValue;
    }
    get metadata() {
        return this.metadataValue;
    }
    get plugins() {
        return this.pluginRegistry;
    }
    get eventProcessors() {
        return this.eventProcessorRegistry;
    }
    get breadcrumbs() {
        return this.breadcrumbBuffer;
    }
    // ─── Setters ──────────────────────────────────────────────────────────
    setOptions(options) {
        this.optionsValue = options;
        this.apiKeyValue = options.apiKey;
        this.initIdentityValue = createInitIdentity(options);
        this.metadataValue = {
            sdkName: SDK_NAME,
            sdkVersion: SDK_VERSION,
            service: options.service ?? 'unknown-service',
            environment: options.environment ?? 'production',
            release: options.release ?? '0.0.0-unknown',
        };
    }
    setResolvedConfig(config) {
        this.configValue = deepFreeze(structuredClone(config));
    }
    setRemoteConfig(config) {
        this.remoteConfigValue = deepFreeze(structuredClone(config));
    }
    setInitResponse(response) {
        this.initResponseValue = deepFreeze(structuredClone(response));
    }
    /** @deprecated Use setResolvedConfig instead */
    setConfig(config) {
        this.setRemoteConfig(config);
    }
    clearConfig() {
        this.configValue = null;
        this.remoteConfigValue = null;
        this.initResponseValue = null;
    }
    clear() {
        this.configValue = null;
        this.remoteConfigValue = null;
        this.initResponseValue = null;
        this.apiKeyValue = null;
        this.initIdentityValue = null;
        this.pendingInitIdentityValue = null;
        this.optionsValue = null;
        this.initPromise = null;
        this.pluginRegistry.length = 0;
        this.eventProcessorRegistry.length = 0;
        this.breadcrumbBuffer.clear();
    }
    // ─── API Key ──────────────────────────────────────────────────────────
    getApiKey() {
        if (!this.apiKeyValue) {
            throw new SDKError('SDK API key missing', 'SDK_API_KEY_MISSING');
        }
        return this.apiKeyValue;
    }
    // ─── Identity Dedup ───────────────────────────────────────────────────
    hasSameIdentity(options) {
        return this.initIdentityValue === createInitIdentity(options);
    }
    setPendingIdentity(options) {
        this.pendingInitIdentityValue = createInitIdentity(options);
    }
    clearPendingIdentity() {
        this.pendingInitIdentityValue = null;
    }
    hasSamePendingIdentity(options) {
        return this.pendingInitIdentityValue === createInitIdentity(options);
    }
    setInitPromise(promise) {
        this.initPromise = promise;
    }
    getInitPromise() {
        return this.initPromise;
    }
    // ─── Plugins ──────────────────────────────────────────────────────────
    registerPlugin(plugin) {
        const existing = this.pluginRegistry.find(p => p.meta.name === plugin.meta.name);
        if (existing) {
            throw new SDKError(`Plugin "${plugin.meta.name}" is already registered`, 'DUPLICATE_PLUGIN', { pluginName: plugin.meta.name });
        }
        this.pluginRegistry.push(plugin);
    }
    registerEventProcessor(processor) {
        this.eventProcessorRegistry.push(processor);
    }
    // ─── Breadcrumbs ──────────────────────────────────────────────────────
    initBreadcrumbs(capacity) {
        this.breadcrumbBuffer = new RingBuffer(capacity);
    }
}
export const client = SDKClient.getInstance();
function createInitIdentity(options) {
    return createHash('sha256').update(options.apiKey).digest('hex');
}
function deepFreeze(value) {
    if (value && typeof value === 'object') {
        for (const nested of Object.values(value)) {
            deepFreeze(nested);
        }
        Object.freeze(value);
    }
    return value;
}
//# sourceMappingURL=client.js.map