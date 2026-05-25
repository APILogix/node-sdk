/**
 * request-capture-utils — shared enterprise-grade helpers for HTTP request
 * instrumentation (Express, Fastify, and any future framework adapters).
 *
 * Responsibilities:
 *   1. Single decision point for whether a request should be captured at all
 *      (killswitch, feature controller, ignored routes/methods from remote
 *      config, framework-level overrides).
 *   2. Per-tenant admission control via TenantGovernor.
 *   3. Header / query / body scrubbing aligned with the central
 *      SecurityScrubber (with safe local fallback when not yet initialized).
 *   4. Common metadata extraction (request id, tenant, user, session,
 *      client IP, user agent, referer, content length).
 *
 * Every middleware in the SDK should funnel through this module rather than
 * implementing its own ad-hoc rules. The pipeline still re-applies security
 * scrubbing / sampling later — the helpers here are about (a) cheap early
 * rejection so we don't allocate a context for events we'll never send, and
 * (b) consistent shape for what we do capture.
 */
export interface CaptureGateInput {
    /** Normalized request path (no query string). */
    readonly path: string;
    /** HTTP method (will be uppercased for comparison). */
    readonly method: string;
    /** Tenant id resolved from headers / context, if any. */
    readonly tenantId?: string | undefined;
    /** Framework-level ignore list (string prefix or regex). */
    readonly localIgnorePaths?: readonly (string | RegExp)[] | undefined;
    /** Framework-level ignored methods (strings, case-insensitive). */
    readonly localIgnoreMethods?: readonly string[] | undefined;
}
export interface CaptureGateDecision {
    /** Whether the request should be captured at all. */
    readonly capture: boolean;
    /** Why the request was rejected (debug only). */
    readonly reason?: string;
    /**
     * Whether sensitive payload capture is currently allowed by remote config.
     * Adapters use this to decide if they should attach `body`, `headers`, etc.
     */
    readonly allowHeaders: boolean;
    readonly allowQuery: boolean;
    readonly allowBody: boolean;
    readonly allowResponse: boolean;
    readonly allowCookies: boolean;
}
/**
 * Decide whether a request should be captured. Combines:
 *   - Global SDK killswitch (`disableSDK`)
 *   - Per-feature killswitches (`disableTracing` for the request span,
 *     plus the FeatureController gate on `tracing` since request capture
 *     is treated as part of the tracing surface).
 *   - Framework-level ignore paths/methods (cheapest, evaluated first).
 *   - Remote-config ignored routes / methods.
 *   - Tenant admission control.
 *
 * The function is deliberately pure with respect to the SDK state — it never
 * mutates engines. `recordCaptureAccepted` should be called once the adapter
 * has decided to actually emit the event so the tenant counter advances.
 */
export declare function evaluateCaptureGate(input: CaptureGateInput): CaptureGateDecision;
/**
 * Record that a request capture was admitted for a tenant. Called once the
 * adapter has produced an event and is about to enqueue it.
 */
export declare function recordCaptureAccepted(tenantId?: string | undefined): void;
/**
 * Scrub headers using the SecurityScrubber when available, falling back to
 * a conservative deny-list when the scrubber isn't initialized yet (typical
 * during the first few milliseconds after `init()`).
 */
export declare function scrubHeaders(headers: Record<string, unknown> | undefined): Record<string, unknown> | undefined;
/**
 * Scrub query parameters. Behaviour mirrors `scrubHeaders` — delegate to the
 * SecurityScrubber when available, fall back to the local deny-list otherwise.
 */
export declare function scrubQuery(query: unknown): Record<string, unknown> | undefined;
/**
 * Best-effort body capture. Adapter-supplied raw body is bounded by
 * `MAX_BODY_INSPECT_BYTES` and always passes through scrubbing.
 *
 * Returns `undefined` if body capture is disabled by remote config or if the
 * body cannot be safely sized.
 */
export declare function captureBodySnapshot(rawBody: unknown, allowBody: boolean): {
    bodySize: number | undefined;
    body: Record<string, unknown> | undefined;
};
/**
 * Extract a header value as a single string. Multi-value headers collapse to
 * the first entry — consistent with how Node's http module reports them.
 */
export declare function headerString(value: string | string[] | undefined): string | undefined;
/**
 * Resolve the originating client IP. Prefers `X-Forwarded-For` (first hop),
 * then `X-Real-IP`, then the socket remote address.
 */
export declare function resolveClientIp(headers: Record<string, string | string[] | undefined>, socketRemoteAddress?: string | undefined): string | undefined;
/** Match a path against either string prefixes or regex patterns. */
export declare function matchesIgnoredPath(path: string, patterns: readonly (string | RegExp)[] | undefined): boolean;
//# sourceMappingURL=request-capture-utils.d.ts.map