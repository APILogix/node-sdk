/**
 * Express request-capture middleware.
 *
 * Enterprise-grade integration points:
 *   - KillswitchEngine: short-circuits when SDK or tracing is disabled.
 *   - FeatureController: respects the remote `tracing` feature flag.
 *   - TenantGovernor: atomic per-tenant admission in the canonical pipeline.
 *   - SecurityScrubber: shared scrubbing for headers / query / body.
 *   - ConfigManager: uses the active backend privacy and sampling policy;
 *     middleware ignore lists remain local integration filters only.
 *
 * Span ownership model:
 *   OpenTelemetry HttpInstrumentation owns SERVER span creation when enabled
 *   by remote configuration. This middleware enriches an active span but
 *   never creates a fallback span when HTTP instrumentation is disabled.
 *   It always emits the discrete request event when request capture passes.
 *
 * The AsyncLocalStorage `ContextStore` (request id, breadcrumbs, user/tenant)
 * is established for the request lifetime so descendant work sees consistent
 * SDK context.
 *
 * The middleware is intentionally fail-open: any unexpected error inside
 * the instrumentation path must NEVER take down the host application.
 * Every branch that can throw is wrapped in a defensive try/catch.
 */
import type { NextFunction, Request, Response } from 'express';
export interface PulseExpressOptions {
    /**
     * Paths that should never be captured. Matching is prefix-based for strings
     * and full regex for `RegExp`. Evaluated before any remote-config rules,
     * so this is the cheapest place to silence noisy paths (e.g. `/healthz`).
     */
    readonly ignorePaths?: readonly (string | RegExp)[];
    /** HTTP methods to skip (case-insensitive). Useful for `OPTIONS`/`HEAD`. */
    readonly ignoreMethods?: readonly string[];
    /** Maximum number of breadcrumbs retained on the request scope. */
    readonly maxBreadcrumbs?: number;
    /**
     * IPs of trusted reverse proxies (exact match, or `*` to trust any peer —
     * only safe when the app is unreachable except via a proxy). When the
     * immediate peer is trusted, `X-Forwarded-For` / `X-Real-IP` are used to
     * resolve the client IP; otherwise those headers are ignored because any
     * client can spoof them. Default: no trusted proxies (socket IP wins).
     */
    readonly trustedProxies?: readonly string[];
    /**
     * If true, instruments Express middleware layers to measure execution duration.
     * Emits child spans for middlewares that exceed `minMiddlewareDurationMs` (default: 2ms)
     * or throw an error.
     */
    readonly instrumentMiddleware?: boolean;
    /**
     * Minimum duration in milliseconds for a middleware to emit a child span.
     * Prevents telemetry flooding from microsecond-fast middlewares.
     * Default: 2.0 ms.
     */
    readonly minMiddlewareDurationMs?: number;
    /**
     * Middleware names to skip profiling (e.g. ['query', 'expressInit']).
     */
    readonly ignoreMiddlewares?: readonly (string | RegExp)[];
}
/**
 * Patch Express Layer.prototype once to measure middleware execution durations.
 * Only emits spans if duration >= minDurationMs or if an error is encountered.
 */
export declare function ensureExpressLayersInstrumented(app: any, minDurationMs?: number, ignoreMiddlewares?: readonly (string | RegExp)[]): void;
/**
 * Programmatically instrument an Express Application to profile middleware execution.
 */
export declare function instrumentExpress(app: any, options?: Pick<PulseExpressOptions, 'minMiddlewareDurationMs' | 'ignoreMiddlewares'>): void;
export declare function pulseMiddleware(options?: PulseExpressOptions): (req: Request, res: Response, next: NextFunction) => void;
/**
 * Express error-handling middleware. Place after all routes and before custom error responses.
 * Automatically captures any error passed to next(err) or thrown in route handlers.
 *
 * @example
 * ```ts
 * app.use(pulseMiddleware())
 * // ... routes ...
 * app.use(expressErrorHandler())
 * ```
 */
export declare function expressErrorHandler(): (err: unknown, req: Request, res: Response, next: NextFunction) => void;
