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
import { ConfigManager } from '../core/config-manager.js';
import { FeatureController } from '../core/feature-controller.js';
import { KillswitchEngine } from '../core/killswitch-engine.js';
import { SamplingEngine } from '../core/sampling-engine.js';
import { EntitlementGate } from '../core/entitlement-gate.js';
import { SecurityScrubber } from '../processors/security-scrubber.js';
import { sha256 } from '../utils/hash.js';
import { getLogger } from '../utils/logger.js';
/** Maximum number of bytes of a request body we will inspect. */
const MAX_BODY_INSPECT_BYTES = 64 * 1024;
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
export function evaluateCaptureGate(input) {
    const method = (input.method || '').toUpperCase();
    // 1. Local ignores (cheapest — set at middleware registration time).
    if (matchesIgnoredPath(input.path, input.localIgnorePaths)) {
        return denied('local_ignore_path');
    }
    if (input.localIgnoreMethods && input.localIgnoreMethods.some(m => m.toUpperCase() === method)) {
        return denied('local_ignore_method');
    }
    // 2. Global killswitch.
    const killswitch = KillswitchEngine.getInstance();
    if (killswitch?.isSDKDisabled()) {
        return denied('sdk_disabled');
    }
    // The request capture path is part of the tracing surface. If tracing is
    // killed we should not be emitting `request` events either - they would
    // be orphan signals without trace correlation.
    if (killswitch?.isKilled('disableTracing')) {
        return denied('tracing_disabled');
    }
    if (!EntitlementGate.isAllowed('requestCapture')) {
        return denied('request_capture_not_entitled');
    }
    // 3. Feature controller - `requestCapture` is its own remote-config flag
    // in v3. The `tracing` feature controls span emission, not request events.
    // We keep the tracing check as well because requests carry trace context;
    // disabling tracing while still emitting requests would produce orphan
    // signals.
    const featureCtrl = FeatureController.getInstance();
    if (featureCtrl) {
        if (!featureCtrl.isEnabled('requestCapture'))
            return denied('request_capture_feature_off');
        if (!featureCtrl.isEnabled('tracing'))
            return denied('tracing_feature_off');
    }
    // 4. A request adapter must never invent privacy policy. Middleware is
    // registered only after initialization, but fail closed if lifecycle races
    // make the active snapshot temporarily unavailable.
    const privacy = getPrivacyPolicy();
    if (!privacy)
        return denied('config_unavailable');
    // 5. Tenant admission is performed atomically by the canonical event
    // pipeline so manual and automatic request capture share one quota.
    // 6. Backend route sampling uses longest-prefix matching.
    const samplingEngine = SamplingEngine.getInstance();
    let sampledRate = 1;
    if (samplingEngine && input.sampleKey) {
        const decision = samplingEngine.shouldSampleRequest(input.sampleKey, input.path);
        sampledRate = decision.rate;
        if (!decision.sampled)
            return denied(`sampling_${decision.reason}`);
    }
    return {
        capture: true,
        allowHeaders: privacy.capture.headers,
        allowQuery: privacy.capture.query,
        allowBody: privacy.capture.body,
        allowResponse: privacy.capture.response,
        allowCookies: privacy.capture.cookies,
        maskIp: privacy.maskIp,
        sampledRate,
    };
}
/**
 * Scrub headers using the active SecurityScrubber. If it is unavailable or
 * fails, omit headers rather than inventing local privacy policy.
 */
export function scrubHeaders(headers) {
    if (!headers)
        return undefined;
    const scrubber = SecurityScrubber.getInstance();
    if (!scrubber)
        return undefined;
    try {
        const wrapped = scrubber.scrub({ type: 'request', headers });
        return wrapped.headers;
    }
    catch (error) {
        getLogger().debug('SecurityScrubber.scrub(headers) failed; omitting headers', { error });
        return undefined;
    }
}
/**
 * Scrub query parameters. Behaviour mirrors `scrubHeaders` — delegate to the
 * SecurityScrubber when available, fall back to the local deny-list otherwise.
 */
export function scrubQuery(query) {
    if (!query || typeof query !== 'object' || Array.isArray(query))
        return undefined;
    const scrubber = SecurityScrubber.getInstance();
    if (!scrubber)
        return undefined;
    try {
        const wrapped = scrubber.scrub({ type: 'request', query });
        return wrapped.query;
    }
    catch (error) {
        getLogger().debug('SecurityScrubber.scrub(query) failed; omitting query', { error });
        return undefined;
    }
}
/**
 * Best-effort body capture. Adapter-supplied raw body is bounded by
 * `MAX_BODY_INSPECT_BYTES` and always passes through scrubbing.
 *
 * Returns `undefined` if body capture is disabled by remote config or if the
 * body cannot be safely sized.
 */
export function captureBodySnapshot(rawBody, allowBody) {
    // Perf: the JSON.stringify-based size computation only runs when body
    // capture is enabled. When it isn't, we report size only for bodies with
    // an O(1) length (strings / Uint8Array) and skip serializing objects we
    // are about to discard anyway.
    if (!allowBody) {
        const cheapSize = rawBody != null && typeof rawBody === 'object' && !(rawBody instanceof Uint8Array)
            ? undefined
            : computeBodySize(rawBody);
        return { bodySize: cheapSize, body: undefined };
    }
    const size = computeBodySize(rawBody);
    if (rawBody == null)
        return { bodySize: size, body: undefined };
    // Only objects are scrubbed and forwarded. Strings and Buffers are reported
    // by size only — sending raw bodies is opt-in via remote config and we
    // don't yet have a typed channel for them in `RequestEvent`.
    if (typeof rawBody !== 'object' || Array.isArray(rawBody)) {
        return { bodySize: size, body: undefined };
    }
    const obj = rawBody;
    if (size !== undefined && size > MAX_BODY_INSPECT_BYTES) {
        return { bodySize: size, body: { __truncated: true } };
    }
    const scrubber = SecurityScrubber.getInstance();
    if (!scrubber)
        return { bodySize: size, body: undefined };
    try {
        const wrapped = scrubber.scrub({ type: 'request', body: obj });
        return { bodySize: size, body: wrapped.body };
    }
    catch (error) {
        getLogger().debug('SecurityScrubber.scrub(body) failed; omitting body', { error });
        return { bodySize: size, body: undefined };
    }
}
/**
 * Extract a header value as a single string. Multi-value headers collapse to
 * the first entry — consistent with how Node's http module reports them.
 */
export function headerString(value) {
    if (Array.isArray(value))
        return value[0];
    if (typeof value === 'string')
        return value;
    return undefined;
}
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
export function resolveClientIp(headers, socketRemoteAddress, trustedProxies, maskIp, preferredIp) {
    const rawIp = preferredIp ?? resolveRawClientIp(headers, socketRemoteAddress, trustedProxies);
    if (!rawIp)
        return undefined;
    if (maskIp ?? true)
        return sha256(rawIp).slice(0, 16);
    return rawIp;
}
function resolveRawClientIp(headers, socketRemoteAddress, trustedProxies) {
    if (socketRemoteAddress && isTrustedProxy(socketRemoteAddress, trustedProxies)) {
        const xff = headerString(headers['x-forwarded-for']);
        if (xff) {
            const first = xff.split(',')[0]?.trim();
            if (first)
                return first;
        }
        const real = headerString(headers['x-real-ip']);
        if (real)
            return real;
    }
    return socketRemoteAddress;
}
/** Exact-match trusted proxy check; `*` trusts every peer. */
function isTrustedProxy(socketRemoteAddress, trustedProxies) {
    if (!trustedProxies || trustedProxies.length === 0)
        return false;
    const normalized = socketRemoteAddress.startsWith('::ffff:')
        ? socketRemoteAddress.slice('::ffff:'.length)
        : socketRemoteAddress;
    return trustedProxies.some(proxy => {
        if (proxy === '*')
            return true;
        const entry = proxy.startsWith('::ffff:') ? proxy.slice('::ffff:'.length) : proxy;
        return entry === normalized || proxy === socketRemoteAddress;
    });
}
/** Match a path against either string prefixes or regex patterns. */
export function matchesIgnoredPath(path, patterns) {
    if (!patterns || patterns.length === 0)
        return false;
    return patterns.some(p => (typeof p === 'string' ? path.startsWith(p) : p.test(path)));
}
// ─── Internal helpers ───────────────────────────────────────────────────────
function denied(reason) {
    return {
        capture: false,
        reason,
        allowHeaders: false,
        allowQuery: false,
        allowBody: false,
        allowResponse: false,
        allowCookies: false,
        maskIp: true,
        sampledRate: 0,
    };
}
function getPrivacyPolicy() {
    try {
        const privacy = ConfigManager.getInstance().getConfig().privacy;
        return {
            capture: privacy.capture,
            maskIp: privacy.piiDetection.maskIPs,
        };
    }
    catch {
        return null;
    }
}
function computeBodySize(rawBody) {
    if (rawBody == null)
        return 0;
    if (typeof rawBody === 'string')
        return Buffer.byteLength(rawBody);
    if (rawBody instanceof Uint8Array)
        return rawBody.byteLength;
    if (typeof rawBody === 'object') {
        try {
            return Buffer.byteLength(JSON.stringify(rawBody));
        }
        catch {
            return undefined;
        }
    }
    return undefined;
}
