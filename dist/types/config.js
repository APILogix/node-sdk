import { z } from 'zod';
// ─── Zod Schemas ────────────────────────────────────────────────────────────
export const sdkInitOptionsSchema = z.object({
    apiKey: z.string().trim().min(1, 'apiKey is required'),
    service: z.string().trim().min(1).optional(),
    environment: z.string().trim().min(1).optional(),
    release: z.string().trim().min(1).optional(),
    enableErrors: z.boolean().optional(),
    enablePerformance: z.boolean().optional(),
    enableTracing: z.boolean().optional(),
    enableMetrics: z.boolean().optional(),
    sampleRate: z.number().min(0).max(1).optional(),
    maxBreadcrumbs: z.number().int().min(0).max(1000).optional(),
    plugins: z.array(z.custom()).readonly().optional(),
    eventProcessors: z.array(z.custom()).readonly().optional(),
    beforeBreadcrumb: z.custom(value => typeof value === 'function').optional(),
    beforeSend: z
        .custom(value => typeof value === 'function')
        .optional(),
    debug: z.boolean().optional(),
    logLevel: z.enum(['debug', 'info', 'warning', 'error', 'fatal']).optional(),
    baseUrl: z.string().url().optional(),
    shutdownTimeoutMs: z.number().int().min(1000).max(60000).optional(),
    transport: z
        .object({
        batchSize: z.number().int().min(1).max(10000).optional(),
        flushIntervalMs: z.number().int().min(100).max(60000).optional(),
        maxRetries: z.number().int().min(0).max(20).optional(),
        timeoutMs: z.number().int().min(1000).max(30000).optional(),
        compression: z.enum(['gzip', 'brotli', 'none']).optional(),
        maxPayloadBytes: z.number().int().min(1024).max(10 * 1024 * 1024).optional(),
        maxConcurrentSends: z.number().int().min(1).max(20).optional(),
    })
        .optional(),
}).strict();
//# sourceMappingURL=config.js.map