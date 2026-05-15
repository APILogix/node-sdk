/**
 * Session Manager — tracks user sessions for telemetry correlation.
 *
 * Features:
 * - Automatic session ID generation (UUID v4)
 * - Session expiry detection (idle timeout + max duration)
 * - Session metadata tracking (started at, last activity, event count)
 * - Crash-free session rate calculation
 * - Integration with SDK context store
 *
 * Session lifecycle:
 *   start → active (events increment counter) → idle timeout → ended
 *                                              → max duration → ended
 *                                              → error occurred → marked as crashed
 */
export interface Session {
    /** Unique session identifier. */
    readonly id: string;
    /** Epoch ms when the session was created. */
    readonly startedAt: number;
    /** Epoch ms of the last recorded activity. */
    lastActivityAt: number;
    /** Total number of events recorded in this session. */
    eventCount: number;
    /** Total number of errors recorded in this session. */
    errorCount: number;
    /** Whether this session experienced at least one error. */
    crashed: boolean;
    /** Session status. */
    status: 'active' | 'ended';
}
export interface SessionManagerOptions {
    /** Idle timeout in ms — session ends if no events for this duration. Default: 30 minutes. */
    idleTimeoutMs?: number;
    /** Maximum session duration in ms. Default: 4 hours. */
    maxDurationMs?: number;
}
export declare class SessionManager {
    private currentSession;
    private readonly idleTimeoutMs;
    private readonly maxDurationMs;
    private readonly logger;
    private totalSessions;
    private crashedSessions;
    constructor(options?: SessionManagerOptions);
    /**
     * Get the current session, creating a new one if none exists or the current is expired.
     */
    getSession(): Session;
    /**
     * Get the current session ID, or null if no session.
     */
    getSessionId(): string | null;
    /**
     * Record that an event occurred — bumps the activity timestamp and event count.
     */
    recordActivity(): void;
    /**
     * Record that an error occurred — marks the session as crashed.
     */
    recordError(): void;
    /**
     * End the current session explicitly.
     */
    endSession(reason?: 'explicit' | 'expired' | 'shutdown'): void;
    /**
     * Get the crash-free session rate (0.0 to 1.0).
     */
    getCrashFreeRate(): number;
    /**
     * Get session health summary for observability dashboards.
     */
    getSessionHealth(): {
        totalSessions: number;
        crashedSessions: number;
        crashFreeRate: number;
        currentSessionId: string | null;
        currentSessionAge: number | null;
    };
    /**
     * Reset all state — for testing.
     * @internal
     */
    reset(): void;
    private createSession;
    private isExpired;
}
/**
 * Get the global session manager. Creates one if it doesn't exist.
 */
export declare function getSessionManager(options?: SessionManagerOptions): SessionManager;
/**
 * Reset the global session manager — for testing.
 * @internal
 */
export declare function resetSessionManager(): void;
//# sourceMappingURL=session-manager.d.ts.map