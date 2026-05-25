/**
 * Fastify request-capture plugin.
 *
 * Mirrors the enterprise hardening of `monitorMiddleware` for Express:
 *   - Killswitch + FeatureController gates
 *   - Tenant admission control
 *   - Centralized scrubbing via SecurityScrubber
 *   - Remote-config driven ignored routes / methods / capture toggles
 *
 * The plugin is intentionally fail-open. If any hook throws, the host
 * application continues serving traffic and the SDK logs the failure.
 */
import { type ContextStore } from '../core/context.js';
export interface PulseFastifyOptions {
    readonly ignorePaths?: readonly (string | RegExp)[];
    readonly ignoreMethods?: readonly string[];
    readonly captureHeaders?: boolean;
    readonly captureQuery?: boolean;
    readonly captureBody?: boolean;
    readonly maxBreadcrumbs?: number;
}
type FastifyInstance = {
    addHook(name: 'onRequest', handler: (request: FastifyRequest, reply: FastifyReply, done: HookDone) => void): void;
    addHook(name: 'preHandler', handler: (request: FastifyRequest, reply: FastifyReply, done: HookDone) => void): void;
    addHook(name: 'onResponse', handler: (request: FastifyRequest, reply: FastifyReply, done: HookDone) => void): void;
    addHook(name: 'onError', handler: (request: FastifyRequest, reply: FastifyReply, error: Error, done: HookDone) => void): void;
};
type HookDone = (err?: Error) => void;
type FastifyRequest = {
    id?: string;
    method: string;
    url: string;
    headers: Record<string, string | string[] | undefined>;
    query?: unknown;
    body?: unknown;
    ip?: string;
    socket?: {
        remoteAddress?: string;
    };
    routeOptions?: {
        url?: string;
    };
    routerPath?: string;
    user?: {
        id?: unknown;
        userId?: unknown;
    };
    pulse?: PulseFastifyState;
};
type FastifyReply = {
    statusCode?: number;
    raw?: {
        statusCode?: number;
    };
    getHeader?: (name: string) => string | string[] | number | undefined;
};
interface PulseFastifyState {
    requestId: string;
    store: ContextStore;
    startTime: number;
    captured: boolean;
    tenantId: string | undefined;
    userId: string | undefined;
    sessionId: string | undefined;
    clientIp: string | undefined;
    userAgent: string | undefined;
    referer: string | undefined;
    captureHeaders: boolean;
    captureQuery: boolean;
    captureBody: boolean;
}
export declare function fastifyPulsePlugin(fastify: FastifyInstance, opts: PulseFastifyOptions, done: (err?: Error) => void): void;
export {};
//# sourceMappingURL=fastify.d.ts.map