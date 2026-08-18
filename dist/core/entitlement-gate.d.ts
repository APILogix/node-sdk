/**
 * EntitlementGate — backend billing/capability gates.
 *
 * Distinct from operational features and killswitches:
 *
 *   - `features.*` decides whether a subsystem exists.
 *   - `killswitches.*` is an emergency operational stop.
 *   - `entitlements.*` gates optional developer APIs and the explicitly
 *     modeled automatic request/tracing/error/metrics paths.
 *
 * Semantics:
 *
 *   - **Complete after init.** Every validated snapshot contains every
 *     entitlement boolean. No defaults or partial entitlement merge exists.
 *   - **Pre-init buffering only.** Static checks allow bootstrap telemetry
 *     before a snapshot exists; the validated backend section becomes
 *     authoritative as soon as initialization completes.
 *   - **No-op, never throw.** A denied API returns a noop implementation
 *     or silently drops the call so application code keeps running.
 *   - **Core APIs are never gated.** `captureError()`, `captureMessage()`,
 *     `setUser()`, `setTag()`, `setContext()`, `addBreadcrumb()`, `flush()`
 *     and `shutdown()` do not consult this gate — they are fundamental to
 *     any SDK integration regardless of plan.
 *
 * The gate is consulted on hot paths (custom APIs and automatic capture), so
 * reads are a plain object lookup with no logging or allocation.
 */
import type { EntitlementsConfig, ConfigDiff, RemoteConfigResponse } from '../types/config.js';
export declare class EntitlementGate {
    private static instance;
    private currentState;
    private destroyed;
    private constructor();
    static initialize(entitlements: EntitlementsConfig): EntitlementGate;
    static getInstance(): EntitlementGate | null;
    /**
     * Check whether an optional telemetry API family is entitled.
     * Instance method — hot path, allocation-free.
     */
    isAllowed(entitlement: keyof EntitlementsConfig): boolean;
    /**
     * Static convenience for call sites that may run before `initialize()`
     * (for bootstrap capture before a validated snapshot exists). This temporary
     * pre-init behavior preserves buffering; it is not a wire-schema default.
     */
    static isAllowed(entitlement: keyof EntitlementsConfig): boolean;
    /** Get the full entitlement state (defensive copy). */
    getState(): Readonly<EntitlementsConfig>;
    /**
     * Handle config change event. Called by ConfigManager.onConfigChange().
     * Entitlement flips take effect immediately for new API calls; in-flight
     * spans/profiles are allowed to finish so traces stay coherent.
     */
    handleConfigChange(_diff: ConfigDiff, newConfig: Readonly<RemoteConfigResponse>): Promise<void>;
    destroy(): void;
    static reset(): void;
}
//# sourceMappingURL=entitlement-gate.d.ts.map