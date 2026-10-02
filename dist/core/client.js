import { createHash } from 'node:crypto';
import { RingBuffer } from './ring-buffer.js';
import { SDKError } from './errors.js';
import { ConfigManager } from './config-manager.js';
import { SDK_NAME, SDK_VERSION } from '../constants/version.js';
import { resolveApplicationPackage } from '../utils/package-metadata.js';
import { LifecycleStateMachine } from './state.js';
import { SingleFlight } from './single-flight.js';
class SDKClient {
    static instance;
    stateMachine = new LifecycleStateMachine();
    singleFlight = new SingleFlight();
    initMetadataValue = null;
    apiKeyValue = null;
    initIdentityValue = null;
    pendingInitIdentityValue = null;
    optionsValue = null;
    pluginRegistry = [];
    eventProcessorRegistry = [];
    metadataValue = Object.freeze({
        sdkName: SDK_NAME,
        sdkVersion: SDK_VERSION,
        applicationName: 'unknown-application',
        applicationVersion: '0.0.0-unknown',
        // Bootstrap-only placeholder. The authoritative value is applied by
        // `applyRemoteIdentity()` from `config.sdk.projectId` before the SDK
        // is marked initialized — no event can transport with this placeholder.
        projectId: 'unknown-project',
        environment: 'production',
        release: '0.0.0-unknown',
    });
    breadcrumbBuffer = new RingBuffer(100);
    constructor() { }
    static getInstance() {
        if (!SDKClient.instance)
            SDKClient.instance = new SDKClient();
        return SDKClient.instance;
    }
    get initialized() {
        const state = this.stateMachine.getState();
        return (state === 'initialized' || state === 'stopping') && ConfigManager.getCurrent()?.isLive() === true;
    }
    getState() {
        return this.stateMachine.getState();
    }
    setState(nextState) {
        this.stateMachine.transition(nextState);
    }
    get remoteConfig() {
        return ConfigManager.getCurrent()?.getConfigOrNull() ?? null;
    }
    get initResponse() {
        const config = this.remoteConfig;
        if (!this.initMetadataValue || !config)
            return null;
        return Object.freeze({ ...this.initMetadataValue, config });
    }
    get projectId() {
        return this.remoteConfig?.sdk.projectId ?? null;
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
    setOptions(options) {
        this.optionsValue = options;
        this.apiKeyValue = options.apiKey;
        this.initIdentityValue = createInitIdentity(options);
        const applicationPackage = resolveApplicationPackage(options);
        this.metadataValue = Object.freeze({
            sdkName: SDK_NAME,
            sdkVersion: SDK_VERSION,
            applicationName: applicationPackage.name,
            applicationVersion: applicationPackage.version,
            // Bootstrap-only. The validated backend identity (including
            // projectId) is applied via applyRemoteIdentity() before the SDK is
            // marked initialized.
            projectId: this.metadataValue.projectId,
            environment: 'production',
            release: applicationPackage.version,
        });
    }
    /**
     * Apply the authoritative identity fields from the active remote
     * configuration snapshot. `projectId` always comes exclusively from
     * `config.sdk.projectId` — never from init options, local config,
     * package.json, environment variables, or any other fallback.
     */
    applyRemoteIdentity(config) {
        this.metadataValue = Object.freeze({
            ...this.metadataValue,
            projectId: config.sdk.projectId,
            environment: config.sdk.environment,
            release: config.sdk.release,
        });
    }
    markInitialized() {
        this.setState('initialized');
    }
    setInitResponse(response) {
        const { config: _config, ...metadata } = response;
        this.initMetadataValue = deepFreeze(structuredClone(metadata));
    }
    clearConfig() {
        if (this.stateMachine.canTransitionTo('recovering')) {
            this.setState('recovering');
        }
        this.initMetadataValue = null;
    }
    clear() {
        this.stateMachine.reset();
        this.initMetadataValue = null;
        this.apiKeyValue = null;
        this.initIdentityValue = null;
        this.pendingInitIdentityValue = null;
        this.optionsValue = null;
        this.singleFlight.reset();
        this.pluginRegistry.length = 0;
        this.eventProcessorRegistry.length = 0;
        this.breadcrumbBuffer.clear();
    }
    getApiKey() {
        if (!this.apiKeyValue)
            throw new SDKError('Telemetry API key missing', 'SDK_API_KEY_MISSING');
        return this.apiKeyValue;
    }
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
    get singleFlightCoordinator() {
        return this.singleFlight;
    }
    setInitPromise(promise) {
        this.singleFlight.setPromise(promise);
    }
    getInitPromise() {
        return this.singleFlight.getPromise();
    }
    isInFlight() {
        return this.singleFlight.isInFlight();
    }
    registerPlugin(plugin) {
        if (this.pluginRegistry.some(existing => existing.meta.name === plugin.meta.name)) {
            throw new SDKError(`Plugin "${plugin.meta.name}" is already registered`, 'DUPLICATE_PLUGIN', {
                pluginName: plugin.meta.name,
            });
        }
        this.pluginRegistry.push(plugin);
    }
    registerEventProcessor(processor) {
        this.eventProcessorRegistry.push(processor);
    }
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
        for (const nested of Object.values(value))
            deepFreeze(nested);
        Object.freeze(value);
    }
    return value;
}
