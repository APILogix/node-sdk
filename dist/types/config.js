import { z } from 'zod';
// ─── Remote Config Response (the wire shape) ────────────────────────────────
//
// Every behaviour-affecting knob is in this object. The SDK never invents
// policy — it executes whatever the backend sends. Schema is versioned so
// older SDKs can detect breaking changes and refuse to apply them.
/** Bumped on incompatible schema changes. SDKs reject configs with a higher major. */
export const REMOTE_CONFIG_SCHEMA_VERSION = 1;
// ─── Zod Schema ─────────────────────────────────────────────────────────────
export const sdkInitOptionsSchema = z.object({
    apiKey: z.string().trim().min(1, 'apiKey is required'),
    applicationName: z.string().trim().min(1).optional(),
    applicationVersion: z.string().trim().min(1).optional(),
    packageJsonPath: z.string().trim().min(1).optional(),
    maxBreadcrumbs: z.number().int().min(0).max(1000).optional(),
    plugins: z.array(z.custom()).readonly().optional(),
    eventProcessors: z.array(z.custom()).readonly().optional(),
    beforeBreadcrumb: z.custom(value => typeof value === 'function').optional(),
    beforeSend: z
        .custom(value => typeof value === 'function')
        .optional(),
    debug: z.boolean().optional(),
    logLevel: z.enum(['debug', 'info', 'warning', 'error', 'fatal']).optional(),
    baseUrl: z.string().url().refine(isHttpOrigin, 'baseUrl must be an HTTP(S) origin').optional(),
    shutdownTimeoutMs: z.number().int().min(1000).max(60000).optional(),
    sourceMaps: z
        .object({
        paths: z.array(z.string()).readonly().optional(),
        allowRemote: z.boolean().optional(),
        embedSourceContent: z.boolean().optional(),
    })
        .strict()
        .optional(),
}).strict();
function isHttpOrigin(value) {
    try {
        const url = new URL(value);
        return (url.protocol === 'https:' || url.protocol === 'http:')
            && !url.username
            && !url.password
            && !url.search
            && !url.hash
            && (url.pathname === '' || url.pathname === '/');
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=config.js.map