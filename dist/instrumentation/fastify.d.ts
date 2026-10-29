/**
 * Fastify request-capture plugin.
 *
 * Mirrors the enterprise hardening of `pulseMiddleware` for Express:
 *   - Killswitch + FeatureController gates
 *   - Tenant admission control
 *   - Centralized scrubbing via SecurityScrubber
 *   - Backend-authoritative sampling and privacy capture policy
 *
 * The plugin is intentionally fail-open. If any hook throws, the host
 * application continues serving traffic and the SDK logs the failure.
 */
import { type Span } from '@opentelemetry/api';
import { type ContextStore } from '../core/context.js';
export interface LynkTraceFastifyOptions {
    readonly ignorePaths?: readonly (string | RegExp)[];
    readonly ignoreMethods?: readonly string[];
    readonly maxBreadcrumbs?: number;
    /**
     * IPs of trusted reverse proxies (exact match, or `*` to trust any peer).
     * Forwarded headers (`X-Forwarded-For` / `X-Real-IP`) are only honored
     * when the immediate peer is trusted; otherwise the socket IP wins.
     * Note: `request.ip` already respects Fastify's own `trustProxy` setting
     * and takes precedence when available.
     */
    readonly trustedProxies?: readonly string[];
    /** Capture schema validation responses (HTTP 422). Other 4xx responses are ignored. Default: false. */
    readonly captureValidationErrors?: boolean;
}
type FastifyInstance = {
    addHook(name: 'onRequest', handler: (request: FastifyRequest, reply: FastifyReply, done: HookDone) => void): void;
    addHook(name: 'preHandler', handler: (request: FastifyRequest, reply: FastifyReply, done: HookDone) => void): void;
    addHook(name: 'onResponse', handler: (request: FastifyRequest, reply: FastifyReply, done: HookDone) => void): void;
    addHook(name: 'onError', handler: (request: FastifyRequest, reply: FastifyReply, error: Error, done: HookDone) => void): void;
    addHook(name: 'preSerialization', handler: (request: FastifyRequest, reply: FastifyReply, payload: unknown, done: (err: Error | null, payload?: unknown) => void) => void): void;
    addHook(name: 'onSend', handler: (request: FastifyRequest, reply: FastifyReply, payload: unknown, done: (err: Error | null, payload?: unknown) => void) => void): void;
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
    lynktrace?: LynkTraceFastifyState;
    pulse?: LynkTraceFastifyState;
};
type FastifyReply = {
    statusCode?: number;
    raw?: {
        statusCode?: number;
    };
    getHeader?: (name: string) => string | string[] | number | undefined;
};
export interface LynkTraceFastifyState {
    requestId: string;
    store: ContextStore;
    startTime: number;
    captured: boolean;
    activeSpan?: Span | undefined;
    createdServerSpan?: boolean | undefined;
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
export declare function lynktraceFastifyPlugin(fastify: FastifyInstance, opts: LynkTraceFastifyOptions, done: (err?: Error) => void): void;
export {};
