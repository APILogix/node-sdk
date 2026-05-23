/**
 * ConfigManager — the single source of truth for SDK configuration.
 *
 * Architecture:
 * - On init(), fetches remote config with a 3-second timeout race.
 * - If fetch fails and no cache, uses SAFE_DEFAULTS (all features off, sampling 0, transport disabled).
 * - Config merge priority: Baked-in SDK defaults → Remote Config → User init() options (last wins).
 * - Background refresh loop at cache.ttlSeconds interval.
 * - Atomic config reads via getConfig() returning frozen snapshot.
 * - staleWhileRevalidate: serves last known config while fetching new one in background.
 *
 * Thread safety: All config reads return immutable snapshots. Refresh swaps the reference atomically
 * via a single assignment — no concurrent mutation is possible.
 */
import type { RemoteConfigResponse, SDKInitOptions, ConfigDiff } from '../types/config.js';
type ConfigChangeListener = (diff: ConfigDiff, newConfig: Readonly<RemoteConfigResponse>) => void;
export declare class ConfigManager {
    private static instance;
    /** Current frozen config snapshot — swapped atomically on refresh. */
    private currentConfig;
    private initOptions;
    private refreshTimer;
    private retryTimer;
    private listeners;
    private configUrl;
    private lastFetchSuccess;
    private lastFetchAt;
    private isRefreshing;
    private destroyed;
    private constructor();
    static getInstance(): ConfigManager;
    /**
     * Initialize the config manager.
     * Fetches remote config with a 3-second timeout. If fetch fails, uses safe defaults.
     * Returns the resolved config.
     */
    initialize(options: SDKInitOptions): Promise<Readonly<RemoteConfigResponse>>;
    /**
     * Get the current config snapshot. Always returns a frozen object.
     * Safe to call from any async context — the snapshot is immutable.
     */
    getConfig(): Readonly<RemoteConfigResponse>;
    /**
     * Register a listener for config changes during refresh.
     * Returns an unsubscribe function.
     */
    onConfigChange(listener: ConfigChangeListener): () => void;
    /**
     * Start the background config refresh loop.
     * Interval is determined by cache.ttlSeconds from the current config.
     */
    startRefreshLoop(): void;
    /**
     * Stop the background refresh loop and any pending retry timers.
     */
    stopRefreshLoop(): void;
    /**
     * Refresh config from the backend.
     * If staleWhileRevalidate, serves old config while fetching.
     * Never throws — errors are logged and swallowed.
     */
    refreshConfig(): Promise<void>;
    /**
     * Destroy the config manager. Stops all timers and clears listeners.
     */
    destroy(): void;
    /**
     * Reset the singleton (for testing).
     */
    static reset(): void;
    /**
     * Fetch remote config from POST /v1/sdk-config.
     * Request body includes sdkVersion, service, environment, runtime, capabilities.
     */
    private fetchConfig;
    /**
     * Detect SDK capabilities (feature strings the binary supports).
     */
    private detectCapabilities;
    /**
     * Deep merge configs: base → remote → user overrides (last wins).
     */
    private mergeConfigs;
    /**
     * Build remote config overrides from user init() options.
     * Maps SDKInitOptions fields to RemoteConfigResponse structure.
     */
    private buildUserOverrides;
    /**
     * Apply user overrides to a base config (used when no remote config available).
     */
    private applyUserOverrides;
    /**
     * Deep merge source into target. Mutates target.
     * Arrays are replaced, not merged. Objects are recursively merged.
     */
    private deepMerge;
    /**
     * Deep freeze an object (recursive Object.freeze via structuredClone + freeze).
     */
    private freezeDeep;
    private recursiveFreeze;
    /**
     * Schedule background retry after initial fetch failure (every 30s).
     */
    private scheduleRetry;
}
export {};
//# sourceMappingURL=config-manager.d.ts.map