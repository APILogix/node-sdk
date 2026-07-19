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
import type { PlanTier, PlanFeatures, ResolvedSDKConfig } from '../types/config.js';
/**
 * Always returns the unrestricted profile. The `plan` and `backendOverrides`
 * arguments are accepted but ignored — they came from the old wire format.
 */
export declare function resolvePlanFeatures(_plan?: PlanTier, _backendOverrides?: Partial<PlanFeatures>): PlanFeatures;
/**
 * Offline-fallback alias. Same unrestricted profile — there is nothing to
 * fall back to anymore. Real "no remote config" behaviour is governed by
 * `BAKED_IN_REMOTE_CONFIG` (transport off, sampling 0).
 */
export declare function getOfflineFallbackPlan(): PlanFeatures;
/**
 * Passthrough — no clamping, no warnings. The resolved config goes through
 * unchanged. Behavioural caps now come from `LimitsEngine` reading
 * `RemoteConfigResponse.limits` (clamped to `SAFETY_CEILINGS`).
 */
export declare function clampToPlan(config: ResolvedSDKConfig, plan: PlanFeatures): ResolvedSDKConfig;
/**
 * Always allowed — feature gating moved to `FeatureController` which reads
 * `features.*` from remote config.
 */
export declare function isFeatureAllowed(_feature: 'errors' | 'performance' | 'tracing' | 'metrics' | 'sessions' | 'plugins' | 'beforeSend', _plan: PlanFeatures): boolean;
/**
 * Accepts every plugin. Plugin loading rules (if any) belong to the
 * `FeatureController` going forward.
 */
export declare function validatePluginCount(plugins: readonly unknown[], _plan: PlanFeatures): {
    allowed: number;
    dropped: number;
};
/**
 * Returns the unrestricted profile regardless of the requested tier.
 */
export declare function getPlanDefaults(_tier: PlanTier): PlanFeatures;
//# sourceMappingURL=plan-gate.d.ts.map