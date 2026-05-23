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
 * - Transport route is 'crons' with batchSize=1, flushIntervalMs=0 (immediate).
 */
import { getLogger } from '../utils/logger.js';
/** Default timeout for in-flight cron monitors (5 minutes). */
const DEFAULT_MONITOR_TIMEOUT_MS = 5 * 60 * 1000;
export class CronSubsystem {
    static instance = null;
    emitter;
    metadata;
    inFlight = new Map();
    monitorTimeoutMs = DEFAULT_MONITOR_TIMEOUT_MS;
    destroyed = false;
    constructor(emitter, metadata) {
        this.emitter = emitter;
        this.metadata = metadata;
    }
    static initialize(emitter, metadata) {
        if (CronSubsystem.instance) {
            CronSubsystem.instance.destroy();
        }
        CronSubsystem.instance = new CronSubsystem(emitter, metadata);
        return CronSubsystem.instance;
    }
    static getInstance() {
        return CronSubsystem.instance;
    }
    /**
     * Send a cron check-in event.
     *
     * @param monitorSlug Unique identifier for this cron job (e.g., "daily-cleanup")
     * @param status Check-in status: 'in_progress', 'ok', or 'error'
     * @param options Optional: duration (ms), environment
     */
    checkIn(monitorSlug, status, options) {
        if (this.destroyed)
            return;
        const logger = getLogger();
        if (status === 'in_progress') {
            // Track in-flight monitor with timeout
            const existing = this.inFlight.get(monitorSlug);
            if (existing?.timeoutHandle) {
                clearTimeout(existing.timeoutHandle);
            }
            const timeoutHandle = setTimeout(() => {
                logger.warn(`[CronSubsystem] Monitor '${monitorSlug}' timed out after ${this.monitorTimeoutMs}ms`);
                this.inFlight.delete(monitorSlug);
                // Emit an error check-in for the timeout
                const timeoutEvent = {
                    type: 'cron_checkin',
                    monitorSlug,
                    status: 'error',
                    timestamp: Date.now(),
                    duration: this.monitorTimeoutMs,
                    environment: options?.environment,
                    metadata: this.metadata,
                };
                this.emitter(timeoutEvent);
            }, this.monitorTimeoutMs);
            if (typeof timeoutHandle === 'object' && 'unref' in timeoutHandle) {
                ;
                timeoutHandle.unref();
            }
            this.inFlight.set(monitorSlug, {
                monitorSlug,
                startedAt: Date.now(),
                timeoutHandle,
            });
        }
        else {
            // Completing a monitor — clear in-flight tracking
            const existing = this.inFlight.get(monitorSlug);
            if (existing) {
                if (existing.timeoutHandle)
                    clearTimeout(existing.timeoutHandle);
                this.inFlight.delete(monitorSlug);
            }
        }
        const event = {
            type: 'cron_checkin',
            monitorSlug,
            status,
            timestamp: Date.now(),
            duration: options?.duration,
            environment: options?.environment ?? this.metadata.environment,
            metadata: this.metadata,
        };
        this.emitter(event);
        logger.info(`[CronSubsystem] Check-in: ${monitorSlug} → ${status}`);
    }
    /** Handle config change. */
    handleConfigChange(_diff, _newConfig) {
        // Cron subsystem has no dynamic config beyond enabled/disabled (handled by FeatureController)
    }
    /** Get list of in-flight monitors. */
    getInFlightMonitors() {
        return Array.from(this.inFlight.keys());
    }
    /** Stop and clean up all in-flight monitors. */
    stop() {
        for (const [, monitor] of this.inFlight) {
            if (monitor.timeoutHandle)
                clearTimeout(monitor.timeoutHandle);
        }
        this.inFlight.clear();
        getLogger().info('[CronSubsystem] Stopped');
    }
    destroy() {
        this.stop();
        this.destroyed = true;
        CronSubsystem.instance = null;
    }
    static reset() {
        if (CronSubsystem.instance) {
            CronSubsystem.instance.destroy();
        }
    }
}
//# sourceMappingURL=cron-subsystem.js.map