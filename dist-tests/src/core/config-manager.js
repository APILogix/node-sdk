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
    currentRevision = null;
    remoteClient = null;
    applier = null;
    refreshPromise = null;
    ttlTimer = null;
    destroyed = false;
    state = ConfigState.Pending;
    internalRouteEndpoints = new Set();
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
    updateInternalEndpoints(config) {
        const endpoints = new Set();
        for (const route of Object.values(config.transport.routes)) {
            try {
                const u = new URL(route.url);
                endpoints.add(`${u.origin}${u.pathname}`);
            }
            catch { }
        }
        this.internalRouteEndpoints = endpoints;
    }
    isInternalEndpoint(url) {
        return this.internalRouteEndpoints.has(`${url.origin}${url.pathname}`);
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
        this.currentRevision = prepared.config.meta.configRevision ?? null;
        this.updateInternalEndpoints(prepared.config);
        this.state = ConfigState.Live;
        this.scheduleTtlTimer();
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
    getConfigRevision() {
        return this.currentRevision ?? this.currentConfig?.meta.configRevision ?? null;
    }
    getConfigHash() {
        return this.currentHash;
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
     * Inspect a parsed telemetry acknowledgement. Both change:true and config_u:true signals
     * are actionable. Additional signals are intentionally ignored while the
     * single refresh is in flight.
     */
    handleTelemetryResponse(httpStatus, payload) {
        if (this.destroyed || !this.currentConfig || !this.remoteClient)
            return;
        if (httpStatus < 200 || httpStatus >= 300)
            return;
        if (httpStatus !== 202 && (!isRecord(payload) || payload['status'] !== 202))
            return;
        if (!isRecord(payload))
            return;
        const hasChange = payload['change'] === true || payload['config_u'] === true;
        if (!hasChange)
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
        if (this.ttlTimer) {
            clearTimeout(this.ttlTimer);
            this.ttlTimer = null;
        }
        this.applier = null;
        this.remoteClient = null;
        this.currentConfig = null;
        this.currentHash = null;
        this.currentRevision = null;
        this.state = ConfigState.Pending;
        if (ConfigManager.instance === this)
            ConfigManager.instance = null;
    }
    static reset() {
        ConfigManager.instance?.destroy();
        ConfigManager.instance = null;
    }
    scheduleTtlTimer() {
        if (this.ttlTimer) {
            clearTimeout(this.ttlTimer);
            this.ttlTimer = null;
        }
        if (this.destroyed || !this.currentConfig || !this.remoteClient)
            return;
        const ttlSeconds = this.currentConfig.runtime?.configTtlSeconds ?? 300;
        if (typeof ttlSeconds !== 'number' || ttlSeconds <= 0)
            return;
        const delayMs = Math.max(1000, ttlSeconds * 1000);
        this.ttlTimer = setTimeout(() => {
            if (this.destroyed || this.refreshPromise)
                return;
            const operation = this.refreshOnce();
            this.refreshPromise = operation;
            void operation.finally(() => {
                if (this.refreshPromise === operation)
                    this.refreshPromise = null;
            }).catch(() => undefined);
        }, delayMs);
        this.ttlTimer.unref?.();
    }
    async refreshOnce() {
        const client = this.remoteClient;
        const previous = this.currentConfig;
        if (!client || !previous || this.destroyed)
            return;
        try {
            const payload = await client.fetchLatest(this.currentRevision, this.currentHash);
            if (this.destroyed)
                return;
            // Fast-path: Server confirmed configuration is unchanged.
            // Zero allocations, zero JSON parsing of large doc, zero diffing, zero restarts.
            if (isRecord(payload) && payload['same'] === true) {
                getLogger().debug('[ConfigManager] Refresh returned unchanged config (same: true)');
                this.scheduleTtlTimer();
                return;
            }
            const prepared = prepareConfig(payload);
            if (isOlderSnapshot(prepared.config, previous)) {
                getLogger().warn('[ConfigManager] Ignoring older remote configuration', {
                    activeGeneratedAt: previous.meta.generatedAt,
                    receivedGeneratedAt: prepared.config.meta.generatedAt,
                });
                this.scheduleTtlTimer();
                return;
            }
            if (prepared.hash === this.currentHash) {
                getLogger().debug('[ConfigManager] Refresh returned unchanged config');
                this.scheduleTtlTimer();
                return;
            }
            const applier = this.applier;
            const diff = applier?.diff(previous, prepared.config);
            if (diff && !applier?.hasChanges(diff)) {
                // Meta/hash-only updates still become the active immutable snapshot,
                // but no subsystem is touched.
                this.currentConfig = prepared.config;
                this.currentHash = prepared.hash;
                this.currentRevision = prepared.config.meta.configRevision ?? null;
                this.scheduleTtlTimer();
                return;
            }
            // Atomic commit point. Readers observe either the complete previous
            // snapshot or the complete new snapshot, never a partial mutation.
            this.currentConfig = prepared.config;
            this.currentHash = prepared.hash;
            this.currentRevision = prepared.config.meta.configRevision ?? null;
            this.updateInternalEndpoints(prepared.config);
            if (applier && diff)
                await applier.apply(diff, previous, prepared.config);
            getLogger().info('[ConfigManager] Remote configuration replaced', {
                configHash: prepared.config.meta.configHash,
                configRevision: this.currentRevision,
            });
            this.scheduleTtlTimer();
        }
        catch (error) {
            // Preserve the last valid snapshot. Reschedule TTL timer for next attempt.
            getLogger().warn('[ConfigManager] Refresh failed; retaining last valid configuration', { error });
            this.scheduleTtlTimer();
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
    delete clone.meta.configHash;
    const hash = createHash('sha256').update(stableStringify(clone)).digest('hex');
    const canonicalHash = `sha256:${hash}`;
    clone.meta.configHash = canonicalHash;
    return { config: deepFreeze(clone), hash: canonicalHash };
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
