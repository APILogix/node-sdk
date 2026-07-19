/**
 * EntitlementGate — billing/plan gate for developer-facing optional
 * telemetry APIs.
 *
 * Distinct from the KillswitchEngine and FeatureController:
 *
 *   - `features.*` decides whether a subsystem is instantiated at all
 *     (operational concern).
 *   - `killswitches.*` instantly silences a subsystem in an emergency
 *     (operational concern).
 *   - `entitlements.*` decides whether the *custom developer API surface*
 *     for an optional telemetry family is active (billing/plan concern).
 *
 * Semantics:
 *
 *   - **Fail-open.** When no remote config has arrived yet, or the backend
 *     omits the `entitlements` block entirely, every entitlement is `true`.
 *     Only an explicit `false` from the control plane turns an API into a
 *     no-op.
 *   - **No-op, never throw.** A gated API returns a noop implementation
 *     (non-recording span) or silently drops the call (metrics, logs,
 *     profiles, replays, cron check-ins). Application code keeps running.
 *   - **Core APIs are never gated.** `captureError()`, `captureMessage()`,
 *     `setUser()`, `setTag()`, `setContext()`, `addBreadcrumb()`, `flush()`
 *     and `shutdown()` do not consult this gate — they are fundamental to
 *     any SDK integration regardless of plan.
 *
 * The gate is consulted on hot paths (every `startSpan`, every metric
 * call), so reads are a plain object lookup — no logging, no allocation.
 */
import type { EntitlementsConfig, ConfigDiff, RemoteConfigResponse } from '../types/config.js';
export declare class EntitlementGate {
    private static instance;
    private currentState;
    private destroyed;
    private constructor();
    static initialize(entitlements: EntitlementsConfig | undefined): EntitlementGate;
    static getInstance(): EntitlementGate | null;
    /**
     * Merge a wire entitlements block over the fail-open defaults. Missing
     * keys keep their default (`true`); only explicit `false` narrows.
     */
    private static resolve;
    /**
     * Check whether an optional telemetry API family is entitled.
     * Instance method — hot path, allocation-free.
     */
    isAllowed(entitlement: keyof EntitlementsConfig): boolean;
    /**
     * Static convenience for call sites that may run before `initialize()`
     * (e.g. spans created during application bootstrap). Fail-open: with no
     * gate instance, everything is allowed.
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