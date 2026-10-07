import { createHash } from 'node:crypto';
import { getLogger } from '../utils/logger.js';
import { assertRemoteConfig } from './config-validator.js';
export var ConfigState;
(function (ConfigState) {
    ConfigState["Pending"] = "pending";
    ConfigState["Live"] = "live";
})(ConfigState || (ConfigState = {}));
/**
 * Single source of truth for remote SDK configuration.
 *
 * There is no fallback config, merge layer, local override, polling timer, or
 * retry loop. A validated immutable snapshot is installed from /v1/init and
 * atomically replaced only after a telemetry response asks for a refresh.
 */
export class ConfigManager {
    static instance = null;
    currentConfig = null;
    currentHash = null;
    remoteClient = null;
    applier = null;
    refreshPromise = null;
    destroyed = false;
    state = ConfigState.Pending;
    constructor() { }
    static getInstance() {
        if (!ConfigManager.instance)
            ConfigManager.instance = new ConfigManager();
        return ConfigManager.instance;
    }
    /** Return the live instance without creating one. */
    static getCurrent() {
        return ConfigManager.instance;
    }
    /** Install the complete /v1/init snapshot. */
    initialize(remoteClient, payload) {
        if (this.destroyed)
            throw new Error('ConfigManager has been destroyed');
        if (this.currentConfig)
            return this.currentConfig;
        const prepared = prepareConfig(payload);
        this.remoteClient = remoteClient;
        this.currentConfig = prepared.config;
        this.currentHash = prepared.hash;
        this.state = ConfigState.Live;
        return prepared.config;
    }
    setApplier(applier) {
        if (this.destroyed)
            return;
        this.applier = applier;
    }
    getConfig() {
        if (!this.currentConfig) {
            throw new Error('Remote configuration is not initialized');
        }
        return this.currentConfig;
    }
    getConfigOrNull() {
        return this.currentConfig;
    }
    getState() {
        return this.state;
    }
    isLive() {
        return this.state === ConfigState.Live && this.currentConfig !== null;
    }
    isDestroyed() {
        return this.destroyed;
    }
    isRefreshInFlight() {
        return this.refreshPromise !== null;
    }
    /**
     * Inspect a parsed telemetry acknowledgement. Only a 202/change:true signal
     * is actionable. Additional signals are intentionally ignored while the
     * single refresh is in flight.
     */
    handleTelemetryResponse(httpStatus, payload) {
        if (this.destroyed || !this.currentConfig || !this.remoteClient)
            return;
        if (httpStatus < 200 || httpStatus >= 300)
            return;
        if (!isRecord(payload) || payload['change'] !== true)
            return;
        if (httpStatus !== 202 && payload['status'] !== 202)
            return;
        if (this.refreshPromise)
            return;
        const operation = this.refreshOnce();
        this.refreshPromise = operation;
        void operation.finally(() => {
            if (this.refreshPromise === operation)
                this.refreshPromise = null;
        }).catch(() => undefined);
    }
    /** Test/lifecycle barrier; does not initiate network activity. */
    async waitForRefresh() {
        await this.refreshPromise;
    }
    destroy() {
        if (this.destroyed)
            return;
        this.destroyed = true;
        this.applier = null;
        this.remoteClient = null;
        this.currentConfig = null;
        this.currentHash = null;
        this.state = ConfigState.Pending;
        if (ConfigManager.instance === this)
            ConfigManager.instance = null;
    }
    static reset() {
        ConfigManager.instance?.destroy();
        ConfigManager.instance = null;
    }
    async refreshOnce() {
        const client = this.remoteClient;
        const previous = this.currentConfig;
        if (!client || !previous || this.destroyed)
            return;
        try {
            const payload = await client.fetchLatest();
            if (this.destroyed)
                return;
            const prepared = prepareConfig(payload);
            if (isOlderSnapshot(prepared.config, previous)) {
                getLogger().warn('[ConfigManager] Ignoring older remote configuration', {
                    activeGeneratedAt: previous.meta.generatedAt,
                    receivedGeneratedAt: prepared.config.meta.generatedAt,
                });
                return;
            }
            if (prepared.hash === this.currentHash) {
                getLogger().debug('[ConfigManager] Refresh returned unchanged config');
                return;
            }
            const applier = this.applier;
            const diff = applier?.diff(previous, prepared.config);
            if (diff && !applier?.hasChanges(diff)) {
                // Meta/hash-only updates still become the active immutable snapshot,
                // but no subsystem is touched.
                this.currentConfig = prepared.config;
                this.currentHash = prepared.hash;
                return;
            }
            // Atomic commit point. Readers observe either the complete previous
            // snapshot or the complete new snapshot, never a partial mutation.
            this.currentConfig = prepared.config;
            this.currentHash = prepared.hash;
            if (applier && diff)
                await applier.apply(diff, previous, prepared.config);
            getLogger().info('[ConfigManager] Remote configuration replaced', {
                configHash: prepared.config.meta.configHash,
            });
        }
        catch (error) {
            // Preserve the last valid snapshot. There is deliberately no timer or
            // retry; another fetch is allowed only after a future change:true ACK.
            getLogger().warn('[ConfigManager] Refresh failed; retaining last valid configuration', { error });
        }
    }
}
/** Inspect a fetch Response without delaying telemetry acknowledgement work. */
export function inspectTelemetryResponse(response) {
    if (!response.ok)
        return;
    let copy;
    try {
        copy = response.clone();
    }
    catch {
        return;
    }
    void copy.json().then(payload => ConfigManager.getCurrent()?.handleTelemetryResponse(response.status, payload), () => undefined);
}
/** Inspect an already parsed response (used by the shared JSON transport). */
export function inspectTelemetryPayload(httpStatus, payload) {
    ConfigManager.getCurrent()?.handleTelemetryResponse(httpStatus, payload);
}
function prepareConfig(payload) {
    assertRemoteConfig(payload);
    const clone = structuredClone(payload);
    const hashSource = structuredClone(clone);
    delete hashSource.meta.configHash;
    const hash = createHash('sha256').update(stableStringify(hashSource)).digest('hex');
    const canonicalHash = `sha256:${hash}`;
    const normalized = {
        ...clone,
        meta: { ...clone.meta, configHash: canonicalHash },
    };
    return { config: deepFreeze(normalized), hash: canonicalHash };
}
function stableStringify(value) {
    if (value === null || typeof value !== 'object')
        return JSON.stringify(value) ?? 'null';
    if (Array.isArray(value))
        return `[${value.map(stableStringify).join(',')}]`;
    const object = value;
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${stableStringify(object[key])}`).join(',')}}`;
}
function deepFreeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        for (const nested of Object.values(value))
            deepFreeze(nested);
        Object.freeze(value);
    }
    return value;
}
function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function isOlderSnapshot(candidate, active) {
    const candidateRevision = candidate.meta.configRevision;
    const activeRevision = active.meta.configRevision;
    if (typeof candidateRevision === 'number' && typeof activeRevision === 'number') {
        return candidateRevision < activeRevision;
    }
    const candidateTime = Date.parse(candidate.meta.generatedAt);
    const activeTime = Date.parse(active.meta.generatedAt);
    return Number.isFinite(candidateTime) && Number.isFinite(activeTime) && candidateTime < activeTime;
}
