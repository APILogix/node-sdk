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
import { getLogger } from '../utils/logger.js';
// ─── Plan Defaults ──────────────────────────────────────────────────────────
/**
 * Default feature sets per plan tier.
 * These are the baseline — the backend can override individual fields.
 */
const PLAN_DEFAULTS = {
    free: {
        tier: 'free',
        allowErrors: true,
        allowPerformance: false,
        allowTracing: false,
        allowMetrics: false,
        allowSessions: false,
        allowCustomPlugins: false,
        allowBeforeSend: false,
        allowSamplingOverride: false,
        maxBreadcrumbs: 50,
        maxPlugins: 0,
        maxBatchSize: 5,
        maxQueueSize: 100,
        allowedCompression: ['none'],
    },
    pro: {
        tier: 'pro',
        allowErrors: true,
        allowPerformance: true,
        allowTracing: true,
        allowMetrics: false,
        allowSessions: true,
        allowCustomPlugins: true,
        allowBeforeSend: true,
        allowSamplingOverride: true,
        maxBreadcrumbs: 200,
        maxPlugins: 3,
        maxBatchSize: 25,
        maxQueueSize: 1000,
        allowedCompression: ['gzip', 'none'],
    },
    enterprise: {
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
        maxPlugins: Infinity,
        maxBatchSize: 1000,
        maxQueueSize: 100000,
        allowedCompression: ['gzip', 'brotli', 'none'],
    },
};
/**
 * Fallback plan when the backend is unreachable.
 * Only errors + breadcrumbs — safe minimum.
 */
const OFFLINE_FALLBACK = {
    ...PLAN_DEFAULTS.free,
    tier: 'free',
};
// ─── Plan Resolution ────────────────────────────────────────────────────────
/**
 * Resolve the PlanFeatures from the backend response.
 * Merges backend-provided overrides on top of plan defaults.
 */
export function resolvePlanFeatures(plan, backendOverrides) {
    const tier = plan ?? 'free';
    const defaults = PLAN_DEFAULTS[tier] ?? PLAN_DEFAULTS.free;
    if (!backendOverrides)
        return { ...defaults };
    // Backend can override individual fields on top of defaults
    return {
        tier,
        allowErrors: backendOverrides.allowErrors ?? defaults.allowErrors,
        allowPerformance: backendOverrides.allowPerformance ?? defaults.allowPerformance,
        allowTracing: backendOverrides.allowTracing ?? defaults.allowTracing,
        allowMetrics: backendOverrides.allowMetrics ?? defaults.allowMetrics,
        allowSessions: backendOverrides.allowSessions ?? defaults.allowSessions,
        allowCustomPlugins: backendOverrides.allowCustomPlugins ?? defaults.allowCustomPlugins,
        allowBeforeSend: backendOverrides.allowBeforeSend ?? defaults.allowBeforeSend,
        allowSamplingOverride: backendOverrides.allowSamplingOverride ?? defaults.allowSamplingOverride,
        maxBreadcrumbs: backendOverrides.maxBreadcrumbs ?? defaults.maxBreadcrumbs,
        maxPlugins: backendOverrides.maxPlugins ?? defaults.maxPlugins,
        maxBatchSize: backendOverrides.maxBatchSize ?? defaults.maxBatchSize,
        maxQueueSize: backendOverrides.maxQueueSize ?? defaults.maxQueueSize,
        allowedCompression: backendOverrides.allowedCompression ?? defaults.allowedCompression,
    };
}
/**
 * Get the offline fallback plan (used when backend is unreachable).
 */
export function getOfflineFallbackPlan() {
    return { ...OFFLINE_FALLBACK };
}
// ─── Plan Clamping ──────────────────────────────────────────────────────────
/**
 * Clamp a resolved config to fit within plan limits.
 * - Features the plan doesn't allow are forced OFF (with warnings)
 * - Numeric limits are capped to plan maximums
 * - Compression is restricted to plan-allowed algorithms
 *
 * This is the core enforcement function — called after mergeConfig().
 */
export function clampToPlan(config, plan) {
    const logger = getLogger();
    const warnings = [];
    // ── Feature flags: user can turn OFF but not turn ON above plan ──
    const enableErrors = plan.allowErrors ? config.enableErrors : false;
    if (config.enableErrors && !plan.allowErrors) {
        warnings.push('Error tracking is not available on the free plan');
    }
    const enablePerformance = plan.allowPerformance ? config.enablePerformance : false;
    if (config.enablePerformance && !plan.allowPerformance) {
        warnings.push(`Request monitoring requires a Pro or Enterprise plan (current: ${plan.tier})`);
    }
    const enableTracing = plan.allowTracing ? config.enableTracing : false;
    if (config.enableTracing && !plan.allowTracing) {
        warnings.push(`Distributed tracing requires a Pro or Enterprise plan (current: ${plan.tier})`);
    }
    const enableMetrics = plan.allowMetrics ? config.enableMetrics : false;
    if (config.enableMetrics && !plan.allowMetrics) {
        warnings.push(`Metrics collection requires an Enterprise plan (current: ${plan.tier})`);
    }
    // ── Numeric limits: cap to plan maximum ──
    const maxBreadcrumbs = Math.min(config.maxBreadcrumbs, plan.maxBreadcrumbs);
    if (config.maxBreadcrumbs > plan.maxBreadcrumbs) {
        warnings.push(`maxBreadcrumbs capped to ${plan.maxBreadcrumbs} (${plan.tier} plan limit)`);
    }
    const batchSize = Math.min(config.batchSize, plan.maxBatchSize);
    if (config.batchSize > plan.maxBatchSize) {
        warnings.push(`batchSize capped to ${plan.maxBatchSize} (${plan.tier} plan limit)`);
    }
    const maxQueueSize = Math.min(config.maxQueueSize, plan.maxQueueSize);
    if (config.maxQueueSize > plan.maxQueueSize) {
        warnings.push(`maxQueueSize capped to ${plan.maxQueueSize} (${plan.tier} plan limit)`);
    }
    // ── Sampling: only pro+ can override ──
    const samplingRate = plan.allowSamplingOverride ? config.samplingRate : 1.0;
    if (config.samplingRate !== 1.0 && !plan.allowSamplingOverride) {
        warnings.push(`Custom sampling rate requires a Pro or Enterprise plan; using 1.0 (send all)`);
    }
    // ── Compression: restrict to plan-allowed algorithms ──
    let compression = config.compression;
    if (!plan.allowedCompression.includes(compression)) {
        compression = 'none';
        warnings.push(`Compression '${config.compression}' is not available on the ${plan.tier} plan; falling back to 'none'`);
    }
    // ── Log all warnings ──
    for (const warning of warnings) {
        logger.warn(`[Plan: ${plan.tier}] ${warning}`);
    }
    if (warnings.length > 0) {
        logger.info(`[Plan: ${plan.tier}] ${warnings.length} feature(s) adjusted to match plan limits. Upgrade at https://pulse.dev/pricing`);
    }
    return {
        ...config,
        plan: plan.tier,
        planFeatures: plan,
        enableErrors,
        enablePerformance,
        enableTracing,
        enableMetrics,
        samplingRate,
        maxBreadcrumbs,
        batchSize,
        maxQueueSize,
        compression,
    };
}
// ─── Runtime Feature Checks ─────────────────────────────────────────────────
/**
 * Check if a specific feature is allowed by the current plan.
 * Use this for runtime checks (e.g., before starting a span).
 */
export function isFeatureAllowed(feature, plan) {
    switch (feature) {
        case 'errors': return plan.allowErrors;
        case 'performance': return plan.allowPerformance;
        case 'tracing': return plan.allowTracing;
        case 'metrics': return plan.allowMetrics;
        case 'sessions': return plan.allowSessions;
        case 'plugins': return plan.allowCustomPlugins;
        case 'beforeSend': return plan.allowBeforeSend;
        default: return false;
    }
}
/**
 * Validate plugin count against plan limits.
 * Returns the allowed plugins (truncated if over limit) + warning count.
 */
export function validatePluginCount(plugins, plan) {
    if (!plan.allowCustomPlugins || plan.maxPlugins === 0) {
        return { allowed: 0, dropped: plugins.length };
    }
    const allowed = Math.min(plugins.length, plan.maxPlugins);
    return { allowed, dropped: plugins.length - allowed };
}
/**
 * Get the plan defaults for a given tier (for testing/docs).
 */
export function getPlanDefaults(tier) {
    return { ...PLAN_DEFAULTS[tier] };
}
//# sourceMappingURL=plan-gate.js.map