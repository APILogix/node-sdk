/**
 * CronSubsystem — monitors cron/scheduled jobs via check-in events.
 *
 * Usage:
 *   const monitor = CronSubsystem.getInstance()
 *   monitor.checkIn('daily-cleanup', 'in_progress')
 *   // ... job runs ...
 *   monitor.checkIn('daily-cleanup', 'ok', { duration: 1234 })
 *
 * Behavior:
 * - Only active when features.crons = true.
 * - Emits CronCheckInEvent to the 'crons' transport route.
 * - Three check-in statuses: 'in_progress', 'ok', 'error'.
 * - Tracks in-flight monitors for timeout detection.
 * - Batching and flush timing come from the active `crons` transport route.
 */
import type { ConfigDiff, RemoteConfigResponse } from '../types/config.js';
import type { CronCheckInEvent, EventMetadata } from '../types/event.js';
type CronEmitter = (event: CronCheckInEvent) => void;
export declare class CronSubsystem {
    private static instance;
    private emitter;
    private metadata;
    private inFlight;
    private monitorTimeoutMs;
    private destroyed;
    private constructor();
    static initialize(emitter: CronEmitter, metadata: EventMetadata): CronSubsystem;
    static getInstance(): CronSubsystem | null;
    updateMetadata(metadata: EventMetadata): void;
    /**
     * Send a cron check-in event.
     *
     * @param monitorSlug Unique identifier for this cron job (e.g., "daily-cleanup")
     * @param status Check-in status: 'in_progress', 'ok', or 'error'
     * @param options Optional: duration (ms), environment
     */
    checkIn(monitorSlug: string, status: 'ok' | 'error' | 'in_progress', options?: {
        duration?: number;
        environment?: string;
    }): void;
    /**
     * Handle config change.
     *
     * The crons feature toggle itself is owned by the FeatureController (it
     * initializes/resets this subsystem), but that flip travels an async void
     * path — if this instance is still alive when the diff lands, stop the
     * in-flight monitors immediately so no pending timeout can emit an error
     * check-in against a feature the control plane has already disabled.
     */
    handleConfigChange(diff: ConfigDiff, newConfig: Readonly<RemoteConfigResponse>): void;
    /** Get list of in-flight monitors. */
    getInFlightMonitors(): string[];
    /** Stop and clean up all in-flight monitors. */
    stop(): void;
    destroy(): void;
    static reset(): void;
}
export {};
