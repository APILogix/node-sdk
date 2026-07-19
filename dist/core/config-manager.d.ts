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
/**
 * Bootstrap state machine. Subsystems can read this to decide whether
 * they're allowed to emit telemetry (and which "reason" to attribute to
 * any drops). Transitions are monotonic forward — once we've seen a real
 * config, we don't go back to `pending` even if a later refresh fails
 * (we keep the last known-good config thanks to staleWhileRevalidate).
 */
export declare enum ConfigState {
    /** init() has not run, or no config URL was configured. */
    Pending = "pending",
    /** init() ran but fetch failed/invalid; SDK is on baked-in safe defaults. */
    SafeDefaults = "safe_defaults",
    /** A valid remote config is live. */
    Live = "live"
}
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
    /**
     * Bootstrap state. Starts at `Pending`; transitions to `SafeDefaults`
     * after `initialize()` runs without a successful fetch, or to `Live` once
     * a valid remote config has been merged in.
     */
    private state;
    private constructor();
    static getInstance(): ConfigManager;
    /**
     * Whether this instance has been destroyed.
     * Exposed for shutdown/reinit tests and for guard logic in long-running tasks.
     */
    isDestroyed(): boolean;
    /**
     * Bootstrap state. Subsystems read this so a "no remote config yet" gate
     * can produce a specific drop reason (`config_not_loaded`) instead of a
     * generic feature-off. Monotonic forward — once we've reached `Live` we
     * stay there even across failed refreshes (we keep stale config).
     */
    getState(): ConfigState;
    /** Whether the manager has at least one successful remote fetch. */
    isLive(): boolean;
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
     * Interval is determined by runtime.configTtlSeconds from the current config.
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
     * Destroy the config manager. Idempotent: stops timers, clears listeners,
     * and detaches the singleton so the next getInstance() call yields a fresh
     * instance with no carry-over state.
     */
    destroy(): void;
    /**
     * Reset the singleton (for testing and reinit).
     * Always returns synchronously — pending background fetches are abandoned
     * via the destroyed flag rather than awaited.
     */
    static reset(): void;
    /**
     * Fetch remote config from POST /v1/sdk-config.
     *
     * Two layers of defense beyond the network call:
     *   1. Schema-version gate — refuse configs newer than this SDK understands.
     *   2. Shape validation — refuse malformed/empty/wrong-typed payloads.
     *
     * The request body advertises which schema version the SDK supports so
     * the backend can downgrade the response if it has multiple wire formats
     * to choose from.
     */
    private fetchConfig;
    /**
     * Detect SDK capabilities (feature strings the binary supports).
     * The backend uses this list to know what knobs to send in the response.
     */
    private detectCapabilities;
    /**
     * Deep merge configs: base → remote → user overrides (last wins).
     * After merging, applies safety ceilings/floors so backend mistakes
     * cannot exceed sane SDK-side limits.
     */
    private mergeConfigs;
    /**
     * Apply hard safety ceilings (and a couple of floors) to numeric fields
     * the backend can set. The SDK never trusts a remote value above these
     * bounds — a typo'd config that says `maxQueueSize: 1e9` would otherwise
     * happily try to allocate enough memory to OOM the host.
     *
     * Also performs a no-op when `applyOverridesOnly` is true and the merged
     * config is already a baked-in / safe-defaults snapshot. The clamps are
     * idempotent so it's always safe to run them, but skipping the work
     * during init when no remote config arrived saves a few ms.
     */
    private applySafetyClamps;
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
     * Keys that must never be copied during a deep merge — they would
     * mutate the prototype chain of `target` and produce process-wide
     * prototype pollution. `JSON.parse('{"__proto__":{"polluted":true}}')`
     * creates an object whose `__proto__` is an *own property* of the
     * parsed value, so naive iteration via `Object.keys()` enumerates it
     * and `target[key] = source[key]` resolves to the legacy `__proto__`
     * setter that mutates the prototype chain. Skipping these keys is
     * the standard defence and aligns with how other observability SDKs
     * (Sentry, Datadog) merge backend config.
     *
     * `validateRemoteConfig` doesn't catch this because the wire schema
     * permits unknown keys for forward compatibility — defence in depth
     * therefore lives here.
     */
    private static readonly DANGEROUS_MERGE_KEYS;
    /**
     * Deep merge source into target. Mutates target.
     * Arrays are replaced, not merged. Objects are recursively merged.
     *
     * Refuses to copy `__proto__`, `constructor`, or `prototype` from the
     * source — see `DANGEROUS_MERGE_KEYS` for the rationale.
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