import { CronSubsystem } from '../subsystems/cron-subsystem.js';
import { client } from '../core/client.js';
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
 * import { captureCronCheckIn } from '@vikasbaplawat1/pulse-sdk'
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
export function captureCronCheckIn(monitorSlug, status, options) {
    if (!client.initialized) {
        return;
    }
    const subsystem = CronSubsystem.getInstance();
    if (subsystem) {
        subsystem.checkIn(monitorSlug, status, options);
    }
}
