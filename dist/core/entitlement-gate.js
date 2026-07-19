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
import { SAFE_DEFAULTS_ENTITLEMENTS } from '../constants/defaults.js';
import { getLogger } from '../utils/logger.js';
export class EntitlementGate {
    static instance = null;
    currentState;
    destroyed = false;
    constructor(initialState) {
        this.currentState = EntitlementGate.resolve(initialState);
    }
    static initialize(entitlements) {
        if (EntitlementGate.instance) {
            EntitlementGate.instance.destroy();
        }
        EntitlementGate.instance = new EntitlementGate(entitlements);
        return EntitlementGate.instance;
    }
    static getInstance() {
        return EntitlementGate.instance;
    }
    /**
     * Merge a wire entitlements block over the fail-open defaults. Missing
     * keys keep their default (`true`); only explicit `false` narrows.
     */
    static resolve(entitlements) {
        if (!entitlements)
            return { ...SAFE_DEFAULTS_ENTITLEMENTS };
        return { ...SAFE_DEFAULTS_ENTITLEMENTS, ...entitlements };
    }
    /**
     * Check whether an optional telemetry API family is entitled.
     * Instance method — hot path, allocation-free.
     */
    isAllowed(entitlement) {
        return this.currentState[entitlement];
    }
    /**
     * Static convenience for call sites that may run before `initialize()`
     * (e.g. spans created during application bootstrap). Fail-open: with no
     * gate instance, everything is allowed.
     */
    static isAllowed(entitlement) {
        const gate = EntitlementGate.instance;
        if (!gate || gate.destroyed)
            return true;
        return gate.currentState[entitlement];
    }
    /** Get the full entitlement state (defensive copy). */
    getState() {
        return { ...this.currentState };
    }
    /**
     * Handle config change event. Called by ConfigManager.onConfigChange().
     * Entitlement flips take effect immediately for new API calls; in-flight
     * spans/profiles are allowed to finish so traces stay coherent.
     */
    async handleConfigChange(_diff, newConfig) {
        if (this.destroyed)
            return;
        const next = EntitlementGate.resolve(newConfig.entitlements);
        const logger = getLogger();
        for (const key of Object.keys(next)) {
            const was = this.currentState[key];
            const is = next[key];
            if (was === is)
                continue;
            if (is) {
                logger.info(`[EntitlementGate] entitlement ENABLED: ${key}`);
            }
            else {
                logger.warn(`[EntitlementGate] entitlement REVOKED: ${key} — developer API becomes no-op`);
            }
        }
        this.currentState = next;
    }
    destroy() {
        this.destroyed = true;
        EntitlementGate.instance = null;
    }
    static reset() {
        if (EntitlementGate.instance) {
            EntitlementGate.instance.destroy();
        }
    }
}
//# sourceMappingURL=entitlement-gate.js.map