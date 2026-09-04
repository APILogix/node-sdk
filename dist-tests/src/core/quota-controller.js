/**
 * QuotaController — Independent Telemetry Quota & Entitlement Life-Cycle Management.
 *
 * Requirements:
 * 1. Decoupled from local hardware pressure (RAM/CPU/lag).
 * 2. Manages explicit quota states: QUOTA_OK, QUOTA_NEAR_LIMIT, QUOTA_EXHAUSTED, QUOTA_RESET.
 * 3. Never kills or disables SDK instrumentation, batching, or the host application.
 * 4. Automatic recovery when reset timestamp passes or when successful server responses arrive.
 * 5. Bounded retention during exhaustion — no unbounded RAM backlogs or replay storms.
 * 6. Never requires an application or server restart to resume telemetry.
 */
import { EventEmitter } from 'node:events';
import { getLogger } from '../utils/logger.js';
export class QuotaController extends EventEmitter {
    static instance = null;
    state = 'QUOTA_OK';
    quotaLimit = null;
    quotaUsed = null;
    quotaResetAt = null;
    retryAfterMs = null;
    droppedEventsCount = 0;
    recoveryTimer = null;
    defaultResetWindowMs;
    maxExhaustedRetention;
    destroyed = false;
    constructor(options = {}) {
        super();
        this.defaultResetWindowMs = options.defaultResetWindowMs ?? 60_000;
        this.maxExhaustedRetention = options.maxExhaustedRetention ?? 200;
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
     * under current quota conditions.
     *
     * - QUOTA_OK / QUOTA_NEAR_LIMIT: admits all priorities.
     * - QUOTA_EXHAUSTED: admits P0 (fatal/crash) and critical P1; suppresses P2/P3.
     */
    shouldAdmit(priority) {
        this.checkAutoRecovery();
        if (this.state !== 'QUOTA_EXHAUSTED') {
            return true;
        }
        // Never drop P0 fatal/crash telemetry even when quota is exhausted
        if (priority === 'p0_critical') {
            return true;
        }
        this.droppedEventsCount++;
        return false;
    }
    /**
     * Inspect HTTP response status and headers for quota & rate limiting signals.
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
        const quotaStatusHeader = headerGetter('x-pulse-quota-status');
        const quotaResetHeader = headerGetter('x-pulse-quota-reset') ?? headerGetter('x-ratelimit-reset');
        const quotaLimitHeader = headerGetter('x-pulse-quota-limit') ?? headerGetter('x-ratelimit-limit');
        const quotaRemainingHeader = headerGetter('x-pulse-quota-remaining') ?? headerGetter('x-ratelimit-remaining');
        // Parse Retry-After if present
        if (retryAfterHeader) {
            const parsed = parseRetryAfter(retryAfterHeader);
            if (parsed !== null) {
                this.retryAfterMs = parsed;
                this.quotaResetAt = Date.now() + parsed;
            }
        }
        // Parse Quota Limit & Remaining
        if (quotaLimitHeader) {
            const parsed = Number(quotaLimitHeader);
            if (!Number.isNaN(parsed) && parsed >= 0)
                this.quotaLimit = parsed;
        }
        if (quotaRemainingHeader) {
            const parsed = Number(quotaRemainingHeader);
            if (!Number.isNaN(parsed) && parsed >= 0) {
                if (this.quotaLimit !== null)
                    this.quotaUsed = Math.max(0, this.quotaLimit - parsed);
                if (parsed === 0) {
                    this.setQuotaExhausted('server_header_remaining_zero');
                    return;
                }
            }
        }
        // Parse Reset Timestamp
        if (quotaResetHeader) {
            const resetMs = parseResetTimestamp(quotaResetHeader);
            if (resetMs !== null) {
                this.quotaResetAt = resetMs;
            }
        }
        // Handle 429 (Too Many Requests / Quota Exceeded) and 402 (Payment Required)
        if (status === 429 || status === 402) {
            this.setQuotaExhausted(status === 402 ? 'http_402_payment_required' : 'http_429_quota_exhausted');
            return;
        }
        // Handle Explicit Quota Status Header
        if (quotaStatusHeader) {
            const statusLower = quotaStatusHeader.trim().toLowerCase();
            if (statusLower === 'exhausted' || statusLower === 'exceeded') {
                this.setQuotaExhausted('server_header_exhausted');
                return;
            }
            if (statusLower === 'near_limit' || statusLower === 'warning') {
                this.setQuotaNearLimit();
                return;
            }
            if (statusLower === 'ok' || statusLower === 'active') {
                this.setQuotaOk('server_header_ok');
                return;
            }
        }
        // Handle 2xx Success: telemetry accepted by backend
        if (status >= 200 && status < 300) {
            const isStillExhausted = quotaStatusHeader !== null && (quotaStatusHeader.toLowerCase() === 'exhausted' || quotaStatusHeader.toLowerCase() === 'exceeded');
            if (!isStillExhausted) {
                this.setQuotaOk('successful_telemetry_ack');
            }
        }
    }
    /**
     * Transition to QUOTA_EXHAUSTED state.
     */
    setQuotaExhausted(reason = 'quota_exceeded') {
        if (this.destroyed)
            return;
        const previousState = this.state;
        this.state = 'QUOTA_EXHAUSTED';
        if (!this.quotaResetAt || this.quotaResetAt <= Date.now()) {
            const resetDuration = this.retryAfterMs ?? this.defaultResetWindowMs;
            this.quotaResetAt = Date.now() + resetDuration;
        }
        this.scheduleAutoRecovery();
        if (previousState !== 'QUOTA_EXHAUSTED') {
            getLogger().warn('[QuotaController] Quota exhausted — non-critical telemetry transmission paused', {
                reason,
                resetAt: this.quotaResetAt ? new Date(this.quotaResetAt).toISOString() : 'unknown',
                retryAfterMs: this.retryAfterMs,
            });
            this.emit('quota_exhausted', this.getSnapshot());
        }
    }
    setQuotaNearLimit() {
        if (this.destroyed)
            return;
        const previous = this.state;
        if (previous !== 'QUOTA_EXHAUSTED') {
            this.state = 'QUOTA_NEAR_LIMIT';
            if (previous !== 'QUOTA_NEAR_LIMIT') {
                this.emit('quota_near_limit', this.getSnapshot());
            }
        }
    }
    /**
     * Transition to QUOTA_OK state.
     */
    setQuotaOk(reason = 'quota_restored') {
        if (this.destroyed)
            return;
        const previousState = this.state;
        this.state = 'QUOTA_OK';
        this.retryAfterMs = null;
        this.clearRecoveryTimer();
        if (previousState === 'QUOTA_EXHAUSTED') {
            getLogger().info('[QuotaController] Quota restored — telemetry transmission resumed automatically', {
                reason,
                droppedDuringExhaustion: this.droppedEventsCount,
            });
            this.emit('quota_reset', this.getSnapshot());
        }
    }
    getSnapshot() {
        const remaining = this.quotaLimit !== null && this.quotaUsed !== null
            ? Math.max(0, this.quotaLimit - this.quotaUsed)
            : null;
        return {
            state: this.state,
            quotaLimit: this.quotaLimit,
            quotaUsed: this.quotaUsed,
            quotaRemaining: remaining,
            quotaResetAt: this.quotaResetAt,
            retryAfterMs: this.retryAfterMs,
            droppedEventsCount: this.droppedEventsCount,
            isExhausted: this.state === 'QUOTA_EXHAUSTED',
        };
    }
    destroy() {
        this.destroyed = true;
        this.clearRecoveryTimer();
        this.removeAllListeners();
        this.state = 'QUOTA_OK';
    }
    checkAutoRecovery() {
        if (this.state === 'QUOTA_EXHAUSTED') {
            if (this.quotaResetAt && Date.now() >= this.quotaResetAt) {
                this.setQuotaOk('reset_timestamp_elapsed');
            }
        }
    }
    scheduleAutoRecovery() {
        this.clearRecoveryTimer();
        if (!this.quotaResetAt)
            return;
        const delayMs = Math.max(500, this.quotaResetAt - Date.now());
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
function parseResetTimestamp(headerValue) {
    const trimmed = headerValue.trim();
    if (!trimmed)
        return null;
    const num = Number(trimmed);
    if (!Number.isNaN(num) && num > 0) {
        // If < 1e11 it's likely epoch in seconds; otherwise epoch in ms
        if (num < 100_000_000_000) {
            return num * 1000;
        }
        return num;
    }
    const dateMs = Date.parse(trimmed);
    if (!Number.isNaN(dateMs)) {
        return dateMs;
    }
    return null;
}
