/**
 * Public structured-log capture API.
 *
 * Thin wrapper over the LoggingSubsystem's explicit capture path. Gated by
 * the `logging` entitlement: when the plan does not include log capture,
 * calls are silently dropped (no-op) — application code keeps running.
 *
 * Unlike the core `captureMessage()` (which is always available and emits a
 * `message` event), `captureLog()` emits a structured `log` event routed to
 * the `logs` ingestion route, with level filtering, argument scrubbing and
 * trace correlation applied by the LoggingSubsystem.
 */

import type { SeverityLevel } from '../types/severity.js'
import { LoggingSubsystem } from '../subsystems/logging-subsystem.js'
import { EntitlementGate } from '../core/entitlement-gate.js'
import { getLogger } from '../utils/logger.js'

/** Levels accepted by the public log capture API. */
export type CaptureLogLevel = SeverityLevel | 'log' | 'warn'

/**
 * Capture a structured log event.
 *
 * Arguments are scrubbed with the active privacy rules (sensitive-field
 * redaction + PII masking) before they are attached to the event, so
 * `captureLog('info', 'user login', { password })` never exfiltrates
 * secrets.
 *
 * No-op when:
 *   - the `logging` entitlement is revoked by remote config, or
 *   - the SDK is not initialized / the logging subsystem is disabled.
 *
 * @param level - Log level ('debug', 'info', 'warning'/'warn', 'error', 'fatal')
 * @param message - Human-readable log message (truncated to configured max size)
 * @param args - Optional structured arguments (max 10 kept, scrubbed)
 */
export function captureLog(level: CaptureLogLevel, message: string, ...args: unknown[]): void {
  try {
    if (!EntitlementGate.isAllowed('logging')) return

    const subsystem = LoggingSubsystem.getInstance()
    if (!subsystem) return

    const normalizedLevel = level === 'warn' ? 'warning' : level === 'log' ? 'info' : level
    subsystem.captureLog(normalizedLevel, message, args)
  } catch (err) {
    // Public capture APIs must never throw into user code.
    getLogger().warn('captureLog failed', { error: err })
  }
}
