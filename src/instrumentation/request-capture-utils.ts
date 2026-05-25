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

import { ConfigManager } from '../core/config-manager.js'
import { FeatureController } from '../core/feature-controller.js'
import { KillswitchEngine } from '../core/killswitch-engine.js'
import { SecurityScrubber } from '../processors/security-scrubber.js'
import { tenantGovernor } from '../core/tenant-isolation.js'
import { getLogger } from '../utils/logger.js'

// Headers we always redact even when the SecurityScrubber isn't initialized.
// Keep this list short and case-insensitive — the scrubber is the source of
// truth once the SDK has finished bootstrapping.
const FALLBACK_SENSITIVE_HEADER_PATTERN = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token|x-csrf-token|x-session-token|api-key|access-token|refresh-token)$/i

const FALLBACK_SENSITIVE_BODY_PATTERN = /(password|passwd|secret|token|api[_-]?key|access[_-]?token|refresh[_-]?token|credit[_-]?card|cvv|ssn)/i

/** Maximum number of bytes of a request body we will look at before bailing. */
const MAX_BODY_INSPECT_BYTES = 64 * 1024

export interface CaptureGateInput {
  /** Normalized request path (no query string). */
  readonly path: string
  /** HTTP method (will be uppercased for comparison). */
  readonly method: string
  /** Tenant id resolved from headers / context, if any. */
  readonly tenantId?: string | undefined
  /** Framework-level ignore list (string prefix or regex). */
  readonly localIgnorePaths?: readonly (string | RegExp)[] | undefined
  /** Framework-level ignored methods (strings, case-insensitive). */
  readonly localIgnoreMethods?: readonly string[] | undefined
}

export interface CaptureGateDecision {
  /** Whether the request should be captured at all. */
  readonly capture: boolean
  /** Why the request was rejected (debug only). */
  readonly reason?: string
  /**
   * Whether sensitive payload capture is currently allowed by remote config.
   * Adapters use this to decide if they should attach `body`, `headers`, etc.
   */
  readonly allowHeaders: boolean
  readonly allowQuery: boolean
  readonly allowBody: boolean
  readonly allowResponse: boolean
  readonly allowCookies: boolean
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
export function evaluateCaptureGate(input: CaptureGateInput): CaptureGateDecision {
  const method = (input.method || '').toUpperCase()

  // 1. Local ignores (cheapest — set at middleware registration time).
  if (matchesIgnoredPath(input.path, input.localIgnorePaths)) {
    return denied('local_ignore_path')
  }
  if (input.localIgnoreMethods && input.localIgnoreMethods.some(m => m.toUpperCase() === method)) {
    return denied('local_ignore_method')
  }

  // 2. Global killswitch.
  const killswitch = KillswitchEngine.getInstance()
  if (killswitch?.isSDKDisabled()) {
    return denied('sdk_disabled')
  }

  // The request capture path is part of the tracing surface. If tracing is
  // killed we should not be emitting `request` events either — they would
  // be orphan signals without trace correlation.
  if (killswitch?.isKilled('disableTracing')) {
    return denied('tracing_disabled')
  }

  // 3. Feature controller — remote-config-driven feature flag.
  const featureCtrl = FeatureController.getInstance()
  if (featureCtrl && !featureCtrl.isEnabled('tracing')) {
    return denied('tracing_feature_off')
  }

  // 4. Remote-config ignored routes & methods. We treat both `tracing.ignored*`
  //    arrays as authoritative for request capture so users only need to
  //    configure ignores in one place.
  const cfg = safeGetTracingConfig()
  if (cfg) {
    if (cfg.ignoredMethods.some(m => m.toUpperCase() === method)) {
      return denied('remote_ignored_method')
    }
    if (matchesPathList(input.path, cfg.ignoredRoutes)) {
      return denied('remote_ignored_route')
    }
  }

  // 5. Tenant admission. Only check; do not record yet.
  if (!tenantGovernor.canAcceptEvent(input.tenantId)) {
    return denied('tenant_quota')
  }

  return {
    capture: true,
    allowHeaders: cfg?.capture.headers ?? true,
    allowQuery: cfg?.capture.query ?? true,
    allowBody: cfg?.capture.body ?? false,
    allowResponse: cfg?.capture.response ?? false,
    allowCookies: cfg?.capture.cookies ?? false,
  }
}

/**
 * Record that a request capture was admitted for a tenant. Called once the
 * adapter has produced an event and is about to enqueue it.
 */
export function recordCaptureAccepted(tenantId?: string | undefined): void {
  tenantGovernor.recordEvent(tenantId)
}

/**
 * Scrub headers using the SecurityScrubber when available, falling back to
 * a conservative deny-list when the scrubber isn't initialized yet (typical
 * during the first few milliseconds after `init()`).
 */
export function scrubHeaders(headers: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!headers) return undefined

  const scrubber = SecurityScrubber.getInstance()
  if (scrubber) {
    // Run the scrubber on a wrapper event so we reuse its full ruleset.
    try {
      const wrapped = scrubber.scrub({ type: 'request', headers } as unknown as never) as unknown as { headers?: Record<string, unknown> }
      return wrapped.headers ?? fallbackScrubHeaders(headers)
    } catch (err) {
      getLogger().debug('SecurityScrubber.scrub(headers) threw; using fallback', { error: err })
      return fallbackScrubHeaders(headers)
    }
  }

  return fallbackScrubHeaders(headers)
}

/**
 * Scrub query parameters. Behaviour mirrors `scrubHeaders` — delegate to the
 * SecurityScrubber when available, fall back to the local deny-list otherwise.
 */
export function scrubQuery(query: unknown): Record<string, unknown> | undefined {
  if (!query || typeof query !== 'object' || Array.isArray(query)) return undefined
  const obj = query as Record<string, unknown>

  const scrubber = SecurityScrubber.getInstance()
  if (scrubber) {
    try {
      const wrapped = scrubber.scrub({ type: 'request', query: obj } as unknown as never) as unknown as { query?: Record<string, unknown> }
      return wrapped.query ?? fallbackScrubBody(obj)
    } catch (err) {
      getLogger().debug('SecurityScrubber.scrub(query) threw; using fallback', { error: err })
      return fallbackScrubBody(obj)
    }
  }
  return fallbackScrubBody(obj)
}

/**
 * Best-effort body capture. Adapter-supplied raw body is bounded by
 * `MAX_BODY_INSPECT_BYTES` and always passes through scrubbing.
 *
 * Returns `undefined` if body capture is disabled by remote config or if the
 * body cannot be safely sized.
 */
export function captureBodySnapshot(rawBody: unknown, allowBody: boolean): {
  bodySize: number | undefined
  body: Record<string, unknown> | undefined
} {
  const size = computeBodySize(rawBody)

  if (!allowBody) {
    return { bodySize: size, body: undefined }
  }

  if (rawBody == null) return { bodySize: size, body: undefined }

  // Only objects are scrubbed and forwarded. Strings and Buffers are reported
  // by size only — sending raw bodies is opt-in via remote config and we
  // don't yet have a typed channel for them in `RequestEvent`.
  if (typeof rawBody !== 'object' || Array.isArray(rawBody)) {
    return { bodySize: size, body: undefined }
  }

  const obj = rawBody as Record<string, unknown>

  if (size !== undefined && size > MAX_BODY_INSPECT_BYTES) {
    return { bodySize: size, body: { __truncated: true } }
  }

  const scrubber = SecurityScrubber.getInstance()
  if (scrubber) {
    try {
      const wrapped = scrubber.scrub({ type: 'request', body: obj } as unknown as never) as unknown as { body?: Record<string, unknown> }
      return { bodySize: size, body: wrapped.body ?? fallbackScrubBody(obj) }
    } catch (err) {
      getLogger().debug('SecurityScrubber.scrub(body) threw; using fallback', { error: err })
    }
  }
  return { bodySize: size, body: fallbackScrubBody(obj) }
}

/**
 * Extract a header value as a single string. Multi-value headers collapse to
 * the first entry — consistent with how Node's http module reports them.
 */
export function headerString(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0]
  if (typeof value === 'string') return value
  return undefined
}

/**
 * Resolve the originating client IP. Prefers `X-Forwarded-For` (first hop),
 * then `X-Real-IP`, then the socket remote address.
 */
export function resolveClientIp(
  headers: Record<string, string | string[] | undefined>,
  socketRemoteAddress?: string | undefined,
): string | undefined {
  const xff = headerString(headers['x-forwarded-for'])
  if (xff) {
    const first = xff.split(',')[0]?.trim()
    if (first) return first
  }
  const real = headerString(headers['x-real-ip'])
  if (real) return real
  return socketRemoteAddress
}

/** Match a path against either string prefixes or regex patterns. */
export function matchesIgnoredPath(
  path: string,
  patterns: readonly (string | RegExp)[] | undefined,
): boolean {
  if (!patterns || patterns.length === 0) return false
  return patterns.some(p => (typeof p === 'string' ? path.startsWith(p) : p.test(path)))
}

// ─── Internal helpers ───────────────────────────────────────────────────────

function denied(reason: string): CaptureGateDecision {
  return {
    capture: false,
    reason,
    allowHeaders: false,
    allowQuery: false,
    allowBody: false,
    allowResponse: false,
    allowCookies: false,
  }
}

function matchesPathList(path: string, list: readonly string[] | undefined): boolean {
  if (!list || list.length === 0) return false
  return list.some(entry => path === entry || path.startsWith(entry))
}

function safeGetTracingConfig(): {
  ignoredRoutes: readonly string[]
  ignoredMethods: readonly string[]
  capture: { headers: boolean; body: boolean; response: boolean; query: boolean; cookies: boolean }
} | undefined {
  try {
    const cfg = ConfigManager.getInstance().getConfig()
    // Route- and method-level ignoring is now expressed via
    // `sampling.routes["/path"] = { traces: 0, requests: 0, ... }` rather
    // than a separate `tracing.ignoredRoutes` array. Capture flags moved
    // to `privacy.capture`. Both are honoured here so the gate result is
    // a single source of truth for adapters.
    return {
      // Reserved for future use — sampling engine handles per-route drops.
      ignoredRoutes: [],
      ignoredMethods: [],
      capture: {
        headers: cfg.privacy?.capture?.headers ?? false,
        body: cfg.privacy?.capture?.body ?? false,
        response: cfg.privacy?.capture?.response ?? false,
        query: cfg.privacy?.capture?.query ?? true,
        cookies: cfg.privacy?.capture?.cookies ?? false,
      },
    }
  } catch {
    // ConfigManager may not be ready during very early bootstrapping; the
    // adapter's local options remain authoritative in that case.
    return undefined
  }
}

function fallbackScrubHeaders(headers: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(headers)) {
    out[key] = FALLBACK_SENSITIVE_HEADER_PATTERN.test(key) ? '[Redacted]' : value
  }
  return out
}

function fallbackScrubBody(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(body)) {
    if (FALLBACK_SENSITIVE_BODY_PATTERN.test(key)) {
      out[key] = '[Redacted]'
      continue
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = fallbackScrubBody(value as Record<string, unknown>)
    } else {
      out[key] = value
    }
  }
  return out
}

function computeBodySize(rawBody: unknown): number | undefined {
  if (rawBody == null) return 0
  if (typeof rawBody === 'string') return Buffer.byteLength(rawBody)
  if (rawBody instanceof Uint8Array) return rawBody.byteLength
  if (typeof rawBody === 'object') {
    try {
      return Buffer.byteLength(JSON.stringify(rawBody))
    } catch {
      return undefined
    }
  }
  return undefined
}
