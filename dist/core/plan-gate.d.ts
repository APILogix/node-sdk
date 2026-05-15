/**
 * Plan-Based Feature Gating — Enterprise Feature Access Control
 *
 * Controls which SDK features are available based on the project's plan tier.
 * The backend drives the plan; the SDK enforces limits client-side.
 *
 * Design principles:
 * - ALL features default to ON — the plan caps what's allowed
 * - Users can turn OFF features but can't turn ON features above their plan
 * - Warnings are logged (not errors) when plan limits are hit — SDK never crashes
 * - Graceful fallback: if backend is unreachable, core features only (errors + breadcrumbs)
 */
import type { PlanTier, PlanFeatures, ResolvedSDKConfig } from '../types/config.js';
/**
 * Resolve the PlanFeatures from the backend response.
 * Merges backend-provided overrides on top of plan defaults.
 */
export declare function resolvePlanFeatures(plan: PlanTier | undefined, backendOverrides?: Partial<PlanFeatures>): PlanFeatures;
/**
 * Get the offline fallback plan (used when backend is unreachable).
 */
export declare function getOfflineFallbackPlan(): PlanFeatures;
/**
 * Clamp a resolved config to fit within plan limits.
 * - Features the plan doesn't allow are forced OFF (with warnings)
 * - Numeric limits are capped to plan maximums
 * - Compression is restricted to plan-allowed algorithms
 *
 * This is the core enforcement function — called after mergeConfig().
 */
export declare function clampToPlan(config: ResolvedSDKConfig, plan: PlanFeatures): ResolvedSDKConfig;
/**
 * Check if a specific feature is allowed by the current plan.
 * Use this for runtime checks (e.g., before starting a span).
 */
export declare function isFeatureAllowed(feature: 'errors' | 'performance' | 'tracing' | 'metrics' | 'sessions' | 'plugins' | 'beforeSend', plan: PlanFeatures): boolean;
/**
 * Validate plugin count against plan limits.
 * Returns the allowed plugins (truncated if over limit) + warning count.
 */
export declare function validatePluginCount(plugins: readonly unknown[], plan: PlanFeatures): {
    allowed: number;
    dropped: number;
};
/**
 * Get the plan defaults for a given tier (for testing/docs).
 */
export declare function getPlanDefaults(tier: PlanTier): PlanFeatures;
//# sourceMappingURL=plan-gate.d.ts.map