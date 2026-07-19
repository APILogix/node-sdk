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

import { generateId } from '../utils/uuid.js'
import { epochMs } from '../utils/time.js'
import { getLogger } from '../utils/logger.js'

// ─── Types ──────────────────────────────────────────────────────────────────

export interface Session {
  /** Unique session identifier. */
  readonly id: string
  /** Epoch ms when the session was created. */
  readonly startedAt: number
  /** Epoch ms of the last recorded activity. */
  lastActivityAt: number
  /** Total number of events recorded in this session. */
  eventCount: number
  /** Total number of errors recorded in this session. */
  errorCount: number
  /** Whether this session experienced at least one error. */
  crashed: boolean
  /** Session status. */
  status: 'active' | 'ended'
}

export interface SessionManagerOptions {
  /** Idle timeout in ms — session ends if no events for this duration. Default: 30 minutes. */
  idleTimeoutMs?: number
  /** Maximum session duration in ms. Default: 4 hours. */
  maxDurationMs?: number
}

// ─── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000     // 30 minutes
const DEFAULT_MAX_DURATION_MS = 4 * 60 * 60 * 1000  // 4 hours

// ─── Session Manager ────────────────────────────────────────────────────────

export class SessionManager {
  private currentSession: Session | null = null
  private readonly idleTimeoutMs: number
  private readonly maxDurationMs: number
  private readonly logger = getLogger()

  // Session aggregates for crash-free rate
  private totalSessions = 0
  private crashedSessions = 0

  constructor(options?: SessionManagerOptions) {
    this.idleTimeoutMs = options?.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
    this.maxDurationMs = options?.maxDurationMs ?? DEFAULT_MAX_DURATION_MS
  }

  /**
   * Get the current session, creating a new one if none exists or the current is expired.
   */
  getSession(): Session {
    const now = epochMs()

    if (this.currentSession && this.isExpired(this.currentSession, now)) {
      this.endSession('expired')
    }

    if (!this.currentSession) {
      this.currentSession = this.createSession(now)
      this.totalSessions += 1

      this.logger.debug('Session started', {
        sessionId: this.currentSession.id,
        idleTimeoutMs: this.idleTimeoutMs,
        maxDurationMs: this.maxDurationMs,
      })
    }

    return this.currentSession
  }

  /**
   * Get the current session ID, or null if no session.
   */
  getSessionId(): string | null {
    return this.currentSession?.id ?? null
  }

  /**
   * Record that an event occurred — bumps the activity timestamp and event count.
   */
  recordActivity(): void {
    const session = this.getSession()
    session.lastActivityAt = epochMs()
    session.eventCount += 1
  }

  /**
   * Record that an error occurred — marks the session as crashed.
   */
  recordError(): void {
    const session = this.getSession()
    session.lastActivityAt = epochMs()
    session.errorCount += 1

    if (!session.crashed) {
      session.crashed = true
      this.crashedSessions += 1

      this.logger.debug('Session marked as crashed', {
        sessionId: session.id,
        errorCount: session.errorCount,
      })
    }
  }

  /**
   * End the current session explicitly.
   */
  endSession(reason: 'explicit' | 'expired' | 'shutdown' = 'explicit'): void {
    if (!this.currentSession) return

    this.currentSession.status = 'ended'
    this.logger.debug('Session ended', {
      sessionId: this.currentSession.id,
      reason,
      durationMs: epochMs() - this.currentSession.startedAt,
      eventCount: this.currentSession.eventCount,
      errorCount: this.currentSession.errorCount,
      crashed: this.currentSession.crashed,
    })

    this.currentSession = null
  }

  /**
   * Get the crash-free session rate (0.0 to 1.0).
   */
  getCrashFreeRate(): number {
    if (this.totalSessions === 0) return 1.0
    return (this.totalSessions - this.crashedSessions) / this.totalSessions
  }

  /**
   * Get session health summary for observability dashboards.
   */
  getSessionHealth(): {
    totalSessions: number
    crashedSessions: number
    crashFreeRate: number
    currentSessionId: string | null
    currentSessionAge: number | null
  } {
    const now = epochMs()
    return {
      totalSessions: this.totalSessions,
      crashedSessions: this.crashedSessions,
      crashFreeRate: this.getCrashFreeRate(),
      currentSessionId: this.currentSession?.id ?? null,
      currentSessionAge: this.currentSession ? now - this.currentSession.startedAt : null,
    }
  }

  /**
   * Reset all state — for testing.
   * @internal
   */
  reset(): void {
    this.currentSession = null
    this.totalSessions = 0
    this.crashedSessions = 0
  }

  // ─── Internal ───────────────────────────────────────────────────────────

  private createSession(now: number): Session {
    return {
      id: generateId(),
      startedAt: now,
      lastActivityAt: now,
      eventCount: 0,
      errorCount: 0,
      crashed: false,
      status: 'active',
    }
  }

  private isExpired(session: Session, now: number): boolean {
    // Idle timeout
    if (now - session.lastActivityAt > this.idleTimeoutMs) return true
    // Max duration
    if (now - session.startedAt > this.maxDurationMs) return true
    // Already ended
    if (session.status === 'ended') return true

    return false
  }
}

// ─── Singleton ──────────────────────────────────────────────────────────────

let sessionManager: SessionManager | null = null

/**
 * Get the global session manager. Creates one if it doesn't exist.
 *
 * Note: `options` are honored only when the singleton is first created.
 * Pass `null` to {@link resetSessionManager} between init cycles if you
 * need to change options.
 */
export function getSessionManager(options?: SessionManagerOptions): SessionManager {
  if (!sessionManager) {
    sessionManager = new SessionManager(options)
  }
  return sessionManager
}

/**
 * Return the existing session manager WITHOUT creating one. The event
 * pipeline uses this so session enrichment never manufactures a session as
 * a side effect of unrelated telemetry — a sessionId is attached only when
 * the session subsystem actually started a manager.
 * @internal
 */
export function peekSessionManager(): SessionManager | null {
  return sessionManager
}

/**
 * Reset the global session manager. Idempotent.
 * Ends any active session as 'shutdown' so the final activity timestamp is
 * recorded, then clears the singleton so the next getSessionManager() yields
 * a fresh instance.
 * @internal
 */
export function resetSessionManager(): void {
  if (sessionManager) {
    try {
      sessionManager.endSession('shutdown')
    } catch {
      // Never throw on shutdown — the SDK must always reset cleanly.
    }
    sessionManager = null
  }
}
