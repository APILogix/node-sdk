import { z } from 'zod';
// ─── Remote Config Response (the wire shape & runtime snapshot) ──────────────
//
// Every behaviour-affecting knob is in this object. The SDK never invents
// policy — it executes whatever the backend sends. Schema is versioned so
// older SDKs can detect breaking changes and refuse to apply them.
/** Bumped on incompatible schema changes. SDKs reject configs with a higher major. */
export const REMOTE_CONFIG_SCHEMA_VERSION = 1;
export var ConfigState;
(function (ConfigState) {
    ConfigState["Pending"] = "pending";
    ConfigState["Live"] = "live";
    ConfigState["Fallback"] = "fallback";
    ConfigState["Destroyed"] = "destroyed";
})(ConfigState || (ConfigState = {}));
// ─── Type Guards ────────────────────────────────────────────────────────────
const VALID_ROUTE_NAMES = new Set([
    'traces', 'requests', 'spans', 'errors', 'metrics',
    'logs', 'profiles', 'events', 'crons', 'replays',
]);
export function isNormalizedRemoteConfig(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        return false;
    const c = value;
    return (typeof c['schemaVersion'] === 'number' &&
        c['schemaVersion'] >= 1 &&
        c['sdk'] !== null && typeof c['sdk'] === 'object' &&
        c['features'] !== null && typeof c['features'] === 'object' &&
        c['sampling'] !== null && typeof c['sampling'] === 'object' &&
        c['transport'] !== null && typeof c['transport'] === 'object' &&
        c['limits'] !== null && typeof c['limits'] === 'object' &&
        c['killswitches'] !== null && typeof c['killswitches'] === 'object' &&
        c['privacy'] !== null && typeof c['privacy'] === 'object' &&
        c['instrumentation'] !== null && typeof c['instrumentation'] === 'object' &&
        c['entitlements'] !== null && typeof c['entitlements'] === 'object' &&
        c['meta'] !== null && typeof c['meta'] === 'object');
}
export function isRawRemoteConfig(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function isTransportRouteName(name) {
    return VALID_ROUTE_NAMES.has(name);
}
export function isCompressionType(comp) {
    return comp === 'gzip' || comp === 'none';
}
export function isRoutePriority(prio) {
    return prio === 'critical' || prio === 'high' || prio === 'normal' || prio === 'low';
}
export function isOverflowStrategy(strat) {
    return strat === 'drop_oldest' || strat === 'drop_newest';
}
export function isBackoffStrategy(strat) {
    return strat === 'exponential' || strat === 'linear' || strat === 'fixed';
}
export function isMemoryLimit(mem) {
    return mem === 'auto' || (typeof mem === 'number' && Number.isFinite(mem) && mem > 0);
}
// ─── Zod Schema ─────────────────────────────────────────────────────────────
export const sdkInitOptionsSchema = z.object({
    apiKey: z.string().trim().min(1, 'apiKey is required'),
    initTimeoutMs: z.number().int().min(100).max(30000).optional(),
    initRetries: z.number().int().min(0).max(3).optional(),
    handleSignals: z.boolean().optional(),
    applicationName: z.string().trim().min(1).optional(),
    applicationVersion: z.string().trim().min(1).optional(),
    packageJsonPath: z.string().trim().min(1).optional(),
    plugins: z.array(z.custom()).readonly().optional(),
    eventProcessors: z.array(z.custom()).readonly().optional(),
    beforeBreadcrumb: z.custom(value => typeof value === 'function').optional(),
    beforeSend: z
        .custom(value => typeof value === 'function')
        .optional(),
    debug: z.boolean().optional(),
    logLevel: z.enum(['debug', 'info', 'warning', 'error', 'fatal']).optional(),
    shutdownTimeoutMs: z.number().int().min(1000).max(60000).optional(),
    exitOnUncaughtException: z.boolean().optional(),
    crashTimeoutMs: z.number().int().min(100).max(30000).optional(),
    onFatalError: z.custom(value => typeof value === 'function').optional(),
    sourceMaps: z
        .object({
        paths: z.array(z.string()).readonly().optional(),
        allowRemote: z.boolean().optional(),
        embedSourceContent: z.boolean().optional(),
    })
        .strict()
        .optional(),
    offlineQueue: z
        .union([
        z.boolean(),
        z
            .object({
            enabled: z.boolean().optional(),
            directory: z.string().trim().min(1).optional(),
            maxFileSizeBytes: z.number().int().min(1024).max(100 * 1024 * 1024).optional(),
            maxEvents: z.number().int().min(1).max(100000).optional(),
            eventTtlMs: z.number().int().min(60000).max(7 * 24 * 60 * 60 * 1000).optional(),
            ioTimeoutMs: z.number().int().min(500).max(60000).optional(),
            flushDebounceMs: z.number().int().min(0).max(60000).optional(),
        })
            .strict(),
    ])
        .optional(),
}).strict();
