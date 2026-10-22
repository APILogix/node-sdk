import { CronSubsystem } from '../subsystems/cron-subsystem.js'
import { client } from '../core/client.js'
import { EntitlementGate } from '../core/entitlement-gate.js'
import { enqueueEvent } from '../core/event-pipeline.js'
import { getLogger } from '../utils/logger.js'
import type { CronCheckInEvent } from '../types/event.js'

export interface CronCheckInOptions {
  /** Optional duration in milliseconds. */
  duration?: number
  /** Environment string, overrides the global SDK config if provided. */
  environment?: string
}

/**
 * Capture a cron job check-in event.
 *
 * This allows monitoring scheduled tasks and background jobs. The SDK tracks
 * timeouts automatically if 'in_progress' is emitted without a subsequent 'ok' or 'error'.
 *
 * @param monitorSlug A unique identifier for this scheduled job (e.g., "daily-db-cleanup")
 * @param status The status of the check-in ('in_progress', 'ok', 'error')
 * @param options Additional metadata for the check-in
 *
 * @example
 * ```ts
 * import { captureCronCheckIn } from '@lynktrace/node'
 *
 * captureCronCheckIn('billing-sync', 'in_progress')
 * try {
 *   await runBillingSync()
 *   captureCronCheckIn('billing-sync', 'ok', { duration: 1500 })
 * } catch (err) {
 *   captureCronCheckIn('billing-sync', 'error')
 * }
 * ```
 */
export function captureCronCheckIn(
  monitorSlug: string,
  status: 'ok' | 'error' | 'in_progress',
  options?: CronCheckInOptions
): void {
  // Plan does not include cron monitoring — silently no-op.
  if (!EntitlementGate.isAllowed('crons')) {
    return
  }

  if (!client.initialized) {
    // Pre-init buffering — mirror the pipeline's Gate 4 behaviour used by
    // captureError/captureRequest so early check-ins during module load are
    // not silently lost. The queue drains through processEvent() once init()
    // completes, which routes 'cron_checkin' events to the 'crons' route.
    // In-flight timeout tracking only starts post-init (the subsystem does
    // not exist yet), so a buffered 'in_progress' relies on the completion
    // check-in arriving after init.
    const event: CronCheckInEvent = {
      type: 'cron_checkin',
      monitorSlug,
      status,
      timestamp: Date.now(),
      duration: options?.duration,
      environment: options?.environment,
    }
    const receipt = enqueueEvent(event)
    if (!receipt.accepted) {
      getLogger().debug('Pre-init cron check-in dropped', {
        monitorSlug,
        reason: receipt.reason,
      })
    }
    return
  }

  const subsystem = CronSubsystem.getInstance()
  if (subsystem) {
    subsystem.checkIn(monitorSlug, status, options)
  }
}
