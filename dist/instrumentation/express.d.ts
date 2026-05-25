/**
 * Express request-capture middleware.
 *
 * Enterprise-grade integration points:
 *   - KillswitchEngine: short-circuits when SDK or tracing is disabled.
 *   - FeatureController: respects the remote `tracing` feature flag.
 *   - TenantGovernor: per-tenant admission control before any work.
 *   - SecurityScrubber: shared scrubbing for headers / query / body.
 *   - ConfigManager: honours `tracing.ignoredRoutes`, `tracing.ignoredMethods`,
 *     and `tracing.capture.*` so a single remote-config flip changes capture
 *     behaviour at runtime — no redeploy.
 *
 * The middleware is intentionally fail-open: any unexpected error inside the
 * instrumentation path must NEVER take down the host application. Every
 * branch that can throw is wrapped in a defensive try/catch.
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
    /**
     * Force-capture request headers regardless of remote config. When
     * undefined (default), the remote `tracing.capture.headers` flag wins.
     */
    readonly captureHeaders?: boolean;
    /** Force-capture query string regardless of remote config. */
    readonly captureQuery?: boolean;
    /**
     * Force-capture request body. Only applies when the body is a parsed JSON
     * object (e.g. `express.json()` middleware ran first). Strings and Buffers
     * report size only. Default: governed by remote config.
     */
    readonly captureBody?: boolean;
    /** Maximum number of breadcrumbs retained on the request scope. */
    readonly maxBreadcrumbs?: number;
}
export declare function monitorMiddleware(options?: PulseExpressOptions): (req: Request, res: Response, next: NextFunction) => void;
//# sourceMappingURL=express.d.ts.map