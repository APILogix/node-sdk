/**
 * request-capture-utils — shared enterprise-grade helpers for HTTP request
 * instrumentation (Express, Fastify, and any future framework adapters).
 *
 * Responsibilities:
 *   1. Single decision point for killswitches, feature flags, backend route
 *      sampling, and local framework integration ignores.
 *   2. Fail-closed header/query/body capture through the active backend-owned
 *      privacy policy and SecurityScrubber.
 *   3. Common metadata extraction (request id, tenant, user, session,
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
    /**
     * Stable identifier for this request. Used by the sampling engine for
     * deterministic decisions — the same id will always produce the same
     * sampled/dropped outcome. Typically the request id resolved from
     * headers or generated upstream.
     */
    readonly sampleKey?: string | undefined;
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
    /**
     * Whether resolved client IPs should be hashed before being attached to
     * events. Driven by `privacy.piiDetection.maskIPs` (defaults to true).
     */
    readonly maskIp: boolean;
    /**
     * The sampling rate that was applied (0..1). Useful for adapters that
     * want to attach `pulse.sampling.rate` as a span attribute so the
     * backend can re-weight aggregates.
     */
    readonly sampledRate: number;
}
/**
 * Decide whether a request should be captured. Combines:
 *   - Global SDK killswitch (`disableSDK`)
 *   - Per-feature killswitches (`disableTracing` for the request span,
 *     plus the FeatureController gate on `tracing` since request capture
 *     is treated as part of the tracing surface).
 *   - Framework-level ignore paths/methods (cheapest, evaluated first).
 *   - Backend route sampling using longest-prefix rules.
 *
 * Tenant admission remains atomic in the canonical event pipeline.
 */
export declare function evaluateCaptureGate(input: CaptureGateInput): CaptureGateDecision;
/**
 * Scrub headers using the active SecurityScrubber. If it is unavailable or
 * fails, omit headers rather than inventing local privacy policy.
 */
export declare function scrubHeaders(headers: Record<string, unknown> | undefined): Record<string, unknown> | undefined;
/**
 * Scrub query parameters. Behaviour mirrors `scrubHeaders` — delegate to the
 * SecurityScrubber when available, fall back to the local deny-list otherwise.
 */
export declare function scrubQuery(query: unknown): Record<string, unknown> | undefined;
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
 * Resolve the originating client IP.
 *
 * `X-Forwarded-For` / `X-Real-IP` are client-controllable headers — any
 * caller can spoof them unless a trusted proxy overwrites them upstream.
 * They are therefore only honored when the immediate peer
 * (`socketRemoteAddress`) is in `trustedProxies` (exact IP match, or `*`
 * to trust any peer — only safe when the app is unreachable except via a
 * proxy). With no trusted proxies configured (the default), the socket
 * address is authoritative and forwarding headers are ignored.
 */
export declare function resolveClientIp(headers: Record<string, string | string[] | undefined>, socketRemoteAddress?: string | undefined, trustedProxies?: readonly string[] | undefined, maskIp?: boolean | undefined, preferredIp?: string | undefined): string | undefined;
/** Match a path against either string prefixes or regex patterns. */
export declare function matchesIgnoredPath(path: string, patterns: readonly (string | RegExp)[] | undefined): boolean;
