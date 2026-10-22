/**
 * QuotaController — Transport Rate-Limit & Backpressure Controller.
 *
 * Architectural Separation:
 * 1. The LynkTrace backend is the single source of truth for customer usage,
 *    monthly quotas, billing entitlement, subscription plans, and quota resets.
 * 2. The SDK does NOT maintain customer billing state or calculate usage.
 * 3. This controller is strictly a transport-level mechanism to protect the
 *    host application and backend during temporary HTTP 429 rate-limiting.
 * 4. Automatic recovery resumes normal transmission when Retry-After expires
 *    or when successful 2xx responses arrive, with zero application restarts.
 * 5. P0 fatal/crash telemetry is NEVER dropped, even under rate-limit backoff.
 */
import { EventEmitter } from 'node:events';
import type { QuotaState, TelemetryPriority } from '../types/telemetry-classes.js';
export interface QuotaStatusSnapshot {
    readonly state: QuotaState;
    /** @deprecated Quota limits are owned by LynkTrace backend. Always null in SDK. */
    readonly quotaLimit: number | null;
    /** @deprecated Quota usage accounting is owned by LynkTrace backend. Always null in SDK. */
    readonly quotaUsed: number | null;
    /** @deprecated Quota remaining is owned by LynkTrace backend. Always null in SDK. */
    readonly quotaRemaining: number | null;
    /** @deprecated Quota reset scheduling is owned by LynkTrace backend. Always null in SDK. */
    readonly quotaResetAt: number | null;
    /** Active backoff delay in ms derived from Retry-After header. */
    readonly retryAfterMs: number | null;
    /** Number of non-critical events dropped locally during active rate-limiting. */
    readonly droppedEventsCount: number;
    /** Drops categorized by telemetry priority. */
    readonly droppedByPriority: Readonly<Record<TelemetryPriority, number>>;
    /** Whether the SDK is currently in rate-limit backoff state. */
    readonly isExhausted: boolean;
}
export interface QuotaControllerOptions {
    /** Fallback backoff duration in ms if none provided by Retry-After. Default: 60,000ms */
    readonly defaultResetWindowMs?: number;
    /** Max high-priority events retained during backoff. Default: 200 */
    readonly maxExhaustedRetention?: number;
}
export declare class QuotaController extends EventEmitter {
    private static instance;
    private state;
    private retryAfterMs;
    private backoffUntilMs;
    private droppedEventsCount;
    private droppedByPriority;
    private recoveryTimer;
    private readonly defaultResetWindowMs;
    private destroyed;
    constructor(options?: QuotaControllerOptions);
    static getInstance(): QuotaController;
    static reset(): void;
    getState(): QuotaState;
    isExhausted(): boolean;
    /**
     * Determine whether an event of the given priority should be admitted
     * under current transport rate-limit conditions.
     *
     * - QUOTA_OK: admits all priorities.
     * - QUOTA_EXHAUSTED (Rate-Limited): admits P0 (fatal/crash) to guarantee delivery;
     *   sheds non-critical telemetry to protect host application memory while backend throttles.
     */
    shouldAdmit(priority: TelemetryPriority): boolean;
    /**
     * Inspect HTTP response status and headers for transport rate-limiting signals.
     * Billing/usage headers (x-lynktrace-quota-*, x-pulse-quota-*) are intentionally ignored as billing
     * is owned entirely by the LynkTrace backend.
     */
    inspectResponse(status: number, headers?: Headers | Record<string, string | string[] | undefined>): void;
    /**
     * Transition to rate-limited backoff state (labeled QUOTA_EXHAUSTED for backwards compatibility).
     */
    setQuotaExhausted(reason?: string): void;
    /**
     * @deprecated Billing warnings are owned by the backend. Kept as no-op for backwards compatibility.
     */
    setQuotaNearLimit(): void;
    /**
     * Transition to QUOTA_OK state when rate-limiting clears.
     */
    setQuotaOk(reason?: string): void;
    getSnapshot(): QuotaStatusSnapshot;
    destroy(): void;
    private checkAutoRecovery;
    private scheduleAutoRecovery;
    private clearRecoveryTimer;
}
export declare const quotaController: QuotaController;
