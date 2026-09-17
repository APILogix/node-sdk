/**
 * QuotaController — Transport Rate-Limit & Backpressure Controller.
 *
 * Architectural Separation:
 * 1. The Pulse backend is the single source of truth for customer usage,
 *    monthly quotas, billing entitlement, subscription plans, and quota resets.
 * 2. The SDK does NOT maintain customer billing state or calculate usage.
 * 3. This controller is strictly a transport-level mechanism to protect the
 *    host application and backend during temporary HTTP 429 rate-limiting.
 * 4. Automatic recovery resumes normal transmission when Retry-After expires
 *    or when successful 2xx responses arrive, with zero application restarts.
 * 5. P0 fatal/crash telemetry is NEVER dropped, even under rate-limit backoff.
 */
import { EventEmitter } from 'node:events';
import { getLogger } from '../utils/logger.js';
export class QuotaController extends EventEmitter {
    static instance = null;
    state = 'QUOTA_OK';
    retryAfterMs = null;
    backoffUntilMs = null;
    droppedEventsCount = 0;
    droppedByPriority = {
        p0_critical: 0,
        p1_error: 0,
        p2_request: 0,
        p3_low: 0,
    };
    recoveryTimer = null;
    defaultResetWindowMs;
    destroyed = false;
    constructor(options = {}) {
        super();
        this.defaultResetWindowMs = options.defaultResetWindowMs ?? 60_000;
    }
    static getInstance() {
        if (!QuotaController.instance) {
            QuotaController.instance = new QuotaController();
        }
        return QuotaController.instance;
    }
    static reset() {
        if (QuotaController.instance) {
            QuotaController.instance.destroy();
            QuotaController.instance = null;
        }
    }
    getState() {
        this.checkAutoRecovery();
        return this.state;
    }
    isExhausted() {
        this.checkAutoRecovery();
        return this.state === 'QUOTA_EXHAUSTED';
    }
    /**
     * Determine whether an event of the given priority should be admitted
     * under current transport rate-limit conditions.
     *
     * - QUOTA_OK: admits all priorities.
     * - QUOTA_EXHAUSTED (Rate-Limited): admits P0 (fatal/crash) to guarantee delivery;
     *   sheds non-critical telemetry to protect host application memory while backend throttles.
     */
    shouldAdmit(priority) {
        this.checkAutoRecovery();
        if (this.state !== 'QUOTA_EXHAUSTED') {
            return true;
        }
        // Never drop P0 fatal/crash telemetry even during rate-limit backoff
        if (priority === 'p0_critical') {
            return true;
        }
        this.droppedEventsCount++;
        this.droppedByPriority[priority] = (this.droppedByPriority[priority] ?? 0) + 1;
        return false;
    }
    /**
     * Inspect HTTP response status and headers for transport rate-limiting signals.
     * Billing/usage headers (x-pulse-quota-*) are intentionally ignored as billing
     * is owned entirely by the Pulse backend.
     */
    inspectResponse(status, headers) {
        if (this.destroyed)
            return;
        const headerGetter = (name) => {
            if (!headers)
                return null;
            if (typeof headers.get === 'function') {
                return headers.get(name);
            }
            const record = headers;
            const lower = name.toLowerCase();
            for (const [key, value] of Object.entries(record)) {
                if (key.toLowerCase() === lower) {
                    if (Array.isArray(value))
                        return value[0] ?? null;
                    return typeof value === 'string' ? value : null;
                }
            }
            return null;
        };
        const retryAfterHeader = headerGetter('retry-after');
        // Parse standard HTTP Retry-After if present
        if (retryAfterHeader) {
            const parsed = parseRetryAfter(retryAfterHeader);
            if (parsed !== null) {
                this.retryAfterMs = parsed;
                this.backoffUntilMs = Date.now() + parsed;
            }
        }
        // Handle 429 (Too Many Requests / Ingestion Rate Limited)
        if (status === 429) {
            this.setQuotaExhausted('http_429_rate_limited');
            return;
        }
        // Handle 2xx Success: telemetry accepted by backend -> restores normal ingestion
        if (status >= 200 && status < 300) {
            this.setQuotaOk('successful_telemetry_ack');
        }
    }
    /**
     * Transition to rate-limited backoff state (labeled QUOTA_EXHAUSTED for backwards compatibility).
     */
    setQuotaExhausted(reason = 'rate_limited') {
        if (this.destroyed)
            return;
        const previousState = this.state;
        this.state = 'QUOTA_EXHAUSTED';
        if (!this.backoffUntilMs || this.backoffUntilMs <= Date.now()) {
            const backoffDuration = this.retryAfterMs ?? this.defaultResetWindowMs;
            this.backoffUntilMs = Date.now() + backoffDuration;
        }
        this.scheduleAutoRecovery();
        if (previousState !== 'QUOTA_EXHAUSTED') {
            getLogger().warn('[QuotaController] Ingestion throttled (HTTP 429) — non-critical telemetry paused for rate-limit protection', {
                reason,
                backoffUntil: new Date(this.backoffUntilMs).toISOString(),
                retryAfterMs: this.retryAfterMs,
            });
            this.emit('quota_exhausted', this.getSnapshot());
        }
    }
    /**
     * @deprecated Billing warnings are owned by the backend. Kept as no-op for backwards compatibility.
     */
    setQuotaNearLimit() {
        // No-op: SDK does not maintain customer billing warning state
    }
    /**
     * Transition to QUOTA_OK state when rate-limiting clears.
     */
    setQuotaOk(reason = 'rate_limit_restored') {
        if (this.destroyed)
            return;
        const previousState = this.state;
        this.state = 'QUOTA_OK';
        this.retryAfterMs = null;
        this.backoffUntilMs = null;
        this.clearRecoveryTimer();
        if (previousState === 'QUOTA_EXHAUSTED') {
            getLogger().info('[QuotaController] Rate-limit backoff cleared — telemetry transmission resumed automatically', {
                reason,
                droppedDuringExhaustion: this.droppedEventsCount,
            });
            this.emit('quota_reset', this.getSnapshot());
        }
    }
    getSnapshot() {
        return {
            state: this.state,
            quotaLimit: null,
            quotaUsed: null,
            quotaRemaining: null,
            quotaResetAt: null,
            retryAfterMs: this.retryAfterMs,
            droppedEventsCount: this.droppedEventsCount,
            droppedByPriority: { ...this.droppedByPriority },
            isExhausted: this.state === 'QUOTA_EXHAUSTED',
        };
    }
    destroy() {
        this.destroyed = true;
        this.clearRecoveryTimer();
        this.removeAllListeners();
        this.state = 'QUOTA_OK';
        this.droppedEventsCount = 0;
        this.droppedByPriority = {
            p0_critical: 0,
            p1_error: 0,
            p2_request: 0,
            p3_low: 0,
        };
    }
    checkAutoRecovery() {
        if (this.state === 'QUOTA_EXHAUSTED') {
            if (this.backoffUntilMs && Date.now() >= this.backoffUntilMs) {
                this.setQuotaOk('rate_limit_window_elapsed');
            }
        }
    }
    scheduleAutoRecovery() {
        this.clearRecoveryTimer();
        if (!this.backoffUntilMs)
            return;
        const delayMs = Math.max(50, this.backoffUntilMs - Date.now());
        this.recoveryTimer = setTimeout(() => {
            this.recoveryTimer = null;
            this.checkAutoRecovery();
        }, delayMs);
        this.recoveryTimer.unref?.();
    }
    clearRecoveryTimer() {
        if (this.recoveryTimer) {
            clearTimeout(this.recoveryTimer);
            this.recoveryTimer = null;
        }
    }
}
export const quotaController = QuotaController.getInstance();
// ─── Header Parsing Helpers ──────────────────────────────────────────────────
function parseRetryAfter(headerValue) {
    const trimmed = headerValue.trim();
    if (!trimmed)
        return null;
    // Format 1: Delta-seconds (e.g., "120")
    const seconds = Number(trimmed);
    if (!Number.isNaN(seconds) && seconds >= 0) {
        return Math.min(3_600_000, Math.floor(seconds * 1000));
    }
    // Format 2: HTTP date (e.g., "Wed, 21 Oct 2026 07:28:00 GMT")
    const dateMs = Date.parse(trimmed);
    if (!Number.isNaN(dateMs)) {
        const diff = dateMs - Date.now();
        return Math.max(0, Math.min(3_600_000, diff));
    }
    return null;
}
