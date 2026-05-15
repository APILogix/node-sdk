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
import { generateId } from '../utils/uuid.js';
import { epochMs } from '../utils/time.js';
import { getLogger } from '../utils/logger.js';
// ─── Constants ──────────────────────────────────────────────────────────────
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const DEFAULT_MAX_DURATION_MS = 4 * 60 * 60 * 1000; // 4 hours
// ─── Session Manager ────────────────────────────────────────────────────────
export class SessionManager {
    currentSession = null;
    idleTimeoutMs;
    maxDurationMs;
    logger = getLogger();
    // Session aggregates for crash-free rate
    totalSessions = 0;
    crashedSessions = 0;
    constructor(options) {
        this.idleTimeoutMs = options?.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
        this.maxDurationMs = options?.maxDurationMs ?? DEFAULT_MAX_DURATION_MS;
    }
    /**
     * Get the current session, creating a new one if none exists or the current is expired.
     */
    getSession() {
        const now = epochMs();
        if (this.currentSession && this.isExpired(this.currentSession, now)) {
            this.endSession('expired');
        }
        if (!this.currentSession) {
            this.currentSession = this.createSession(now);
            this.totalSessions += 1;
            this.logger.debug('Session started', {
                sessionId: this.currentSession.id,
                idleTimeoutMs: this.idleTimeoutMs,
                maxDurationMs: this.maxDurationMs,
            });
        }
        return this.currentSession;
    }
    /**
     * Get the current session ID, or null if no session.
     */
    getSessionId() {
        return this.currentSession?.id ?? null;
    }
    /**
     * Record that an event occurred — bumps the activity timestamp and event count.
     */
    recordActivity() {
        const session = this.getSession();
        session.lastActivityAt = epochMs();
        session.eventCount += 1;
    }
    /**
     * Record that an error occurred — marks the session as crashed.
     */
    recordError() {
        const session = this.getSession();
        session.lastActivityAt = epochMs();
        session.errorCount += 1;
        if (!session.crashed) {
            session.crashed = true;
            this.crashedSessions += 1;
            this.logger.debug('Session marked as crashed', {
                sessionId: session.id,
                errorCount: session.errorCount,
            });
        }
    }
    /**
     * End the current session explicitly.
     */
    endSession(reason = 'explicit') {
        if (!this.currentSession)
            return;
        this.currentSession.status = 'ended';
        this.logger.debug('Session ended', {
            sessionId: this.currentSession.id,
            reason,
            durationMs: epochMs() - this.currentSession.startedAt,
            eventCount: this.currentSession.eventCount,
            errorCount: this.currentSession.errorCount,
            crashed: this.currentSession.crashed,
        });
        this.currentSession = null;
    }
    /**
     * Get the crash-free session rate (0.0 to 1.0).
     */
    getCrashFreeRate() {
        if (this.totalSessions === 0)
            return 1.0;
        return (this.totalSessions - this.crashedSessions) / this.totalSessions;
    }
    /**
     * Get session health summary for observability dashboards.
     */
    getSessionHealth() {
        const now = epochMs();
        return {
            totalSessions: this.totalSessions,
            crashedSessions: this.crashedSessions,
            crashFreeRate: this.getCrashFreeRate(),
            currentSessionId: this.currentSession?.id ?? null,
            currentSessionAge: this.currentSession ? now - this.currentSession.startedAt : null,
        };
    }
    /**
     * Reset all state — for testing.
     * @internal
     */
    reset() {
        this.currentSession = null;
        this.totalSessions = 0;
        this.crashedSessions = 0;
    }
    // ─── Internal ───────────────────────────────────────────────────────────
    createSession(now) {
        return {
            id: generateId(),
            startedAt: now,
            lastActivityAt: now,
            eventCount: 0,
            errorCount: 0,
            crashed: false,
            status: 'active',
        };
    }
    isExpired(session, now) {
        // Idle timeout
        if (now - session.lastActivityAt > this.idleTimeoutMs)
            return true;
        // Max duration
        if (now - session.startedAt > this.maxDurationMs)
            return true;
        // Already ended
        if (session.status === 'ended')
            return true;
        return false;
    }
}
// ─── Singleton ──────────────────────────────────────────────────────────────
let sessionManager = null;
/**
 * Get the global session manager. Creates one if it doesn't exist.
 */
export function getSessionManager(options) {
    if (!sessionManager) {
        sessionManager = new SessionManager(options);
    }
    return sessionManager;
}
/**
 * Reset the global session manager — for testing.
 * @internal
 */
export function resetSessionManager() {
    sessionManager?.endSession('shutdown');
    sessionManager = null;
}
//# sourceMappingURL=session-manager.js.map