/**
 * Fastify Framework Instrumentation — automatic request tracing and telemetry.
 *
 * Provides a Fastify plugin that:
 * - Creates per-request async context with trace/span IDs
 * - Automatically captures request events (method, URL, status, latency)
 * - Adds HTTP breadcrumbs
 * - Injects trace context into response headers for downstream consumers
 * - Extracts incoming trace context from request headers (W3C propagation)
 *
 * Usage:
 *   import Fastify from 'fastify'
 *   import { fastifyPulsePlugin } from '@vikasbaplawat1/pulse-sdk'
 *
 *   const app = Fastify()
 *   app.register(fastifyPulsePlugin)
 */
export interface PulseFastifyOptions {
    /** Paths to ignore from instrumentation (e.g., '/health', '/ready'). */
    ignorePaths?: string[];
    /** Whether to capture request headers. Default: true. */
    captureHeaders?: boolean;
    /** Whether to capture query parameters. Default: true. */
    captureQuery?: boolean;
    /** Max breadcrumbs per request context. Default: 100. */
    maxBreadcrumbs?: number;
}
type FastifyInstance = {
    addHook(name: string, handler: (...args: unknown[]) => void): void;
};
/**
 * Fastify plugin for Pulse SDK instrumentation.
 * Register with `app.register(fastifyPulsePlugin)`.
 */
export declare function fastifyPulsePlugin(fastify: FastifyInstance, opts: PulseFastifyOptions, done: (err?: Error) => void): void;
export {};
//# sourceMappingURL=fastify.d.ts.map