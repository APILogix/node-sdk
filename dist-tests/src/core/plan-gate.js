/**
 * Plan-gate — neutralized.
 *
 * The wire schema (post-v3) no longer carries a plan tier. The backend
 * decides what each customer can do and ships a flat config to the SDK.
 * This module used to clamp resolved configs to a "free / pro / enterprise"
 * tier and warn users about features above their plan; that logic now
 * lives entirely server-side.
 *
 * The exports here are kept as compat shims so the (still-public)
 * `ResolvedSDKConfig.planFeatures` type continues to compile and existing
 * call sites don't need to change. Every function effectively returns
 * "unrestricted":
 *
 *   - `resolvePlanFeatures()` returns an `enterprise` profile with no caps.
 *   - `clampToPlan()` is a passthrough — no warnings, no clamping.
 *   - `isFeatureAllowed()` always returns `true`.
 *   - `validatePluginCount()` accepts every plugin.
 *
 * The whole module will be deleted in v5 along with the `plan` and
 * `planFeatures` fields on `ResolvedSDKConfig`. Until then, this stub
 * preserves the public API while making sure no client-side decision
 * ever depends on the plan again.
 */
// ─── Unrestricted profile ───────────────────────────────────────────────────
//
// The single profile returned by every public function. "Enterprise" is the
// historical name for "no SDK-side restrictions"; it has nothing to do with
// the customer's actual subscription tier (that's the backend's concern now).
const UNRESTRICTED = Object.freeze({
    tier: 'enterprise',
    allowErrors: true,
    allowPerformance: true,
    allowTracing: true,
    allowMetrics: true,
    allowSessions: true,
    allowCustomPlugins: true,
    allowBeforeSend: true,
    allowSamplingOverride: true,
    maxBreadcrumbs: 1000,
    maxPlugins: Number.MAX_SAFE_INTEGER,
    maxBatchSize: Number.MAX_SAFE_INTEGER,
    maxQueueSize: Number.MAX_SAFE_INTEGER,
    allowedCompression: ['gzip', 'brotli', 'none'],
});
// ─── Public API (compat shims) ──────────────────────────────────────────────
/**
 * Always returns the unrestricted profile. The `plan` and `backendOverrides`
 * arguments are accepted but ignored — they came from the old wire format.
 */
export function resolvePlanFeatures(_plan, _backendOverrides) {
    return { ...UNRESTRICTED };
}
/**
 * Offline-fallback alias. Same unrestricted profile — there is nothing to
 * fall back to anymore. Real "no remote config" behaviour is governed by
 * `BAKED_IN_REMOTE_CONFIG` (transport off, sampling 0).
 */
export function getOfflineFallbackPlan() {
    return { ...UNRESTRICTED };
}
/**
 * Passthrough — no clamping, no warnings. The resolved config goes through
 * unchanged. Behavioural caps now come from `LimitsEngine` reading
 * `RemoteConfigResponse.limits` (clamped to `SAFETY_CEILINGS`).
 */
export function clampToPlan(config, plan) {
    return {
        ...config,
        plan: plan.tier,
        planFeatures: plan,
    };
}
/**
 * Always allowed — feature gating moved to `FeatureController` which reads
 * `features.*` from remote config.
 */
export function isFeatureAllowed(_feature, _plan) {
    return true;
}
/**
 * Accepts every plugin. Plugin loading rules (if any) belong to the
 * `FeatureController` going forward.
 */
export function validatePluginCount(plugins, _plan) {
    return { allowed: plugins.length, dropped: 0 };
}
/**
 * Returns the unrestricted profile regardless of the requested tier.
 */
export function getPlanDefaults(_tier) {
    return { ...UNRESTRICTED };
}
