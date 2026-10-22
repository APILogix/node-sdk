export interface CronCheckInOptions {
    /** Optional duration in milliseconds. */
    duration?: number;
    /** Environment string, overrides the global SDK config if provided. */
    environment?: string;
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
export declare function captureCronCheckIn(monitorSlug: string, status: 'ok' | 'error' | 'in_progress', options?: CronCheckInOptions): void;
