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

import type { ConfigDiff, RemoteConfigResponse } from '../types/config.js'
import type { CronCheckInEvent, EventMetadata } from '../types/event.js'
import { getLogger } from '../utils/logger.js'
import { context } from '@opentelemetry/api'
import { suppressTracing } from '@opentelemetry/core'

type CronEmitter = (event: CronCheckInEvent) => void

interface InFlightMonitor {
  readonly monitorSlug: string
  readonly startedAt: number
  timeoutHandle: ReturnType<typeof setTimeout> | null
}

/** Default timeout for in-flight cron monitors (5 minutes). */
const DEFAULT_MONITOR_TIMEOUT_MS = 5 * 60 * 1000

export class CronSubsystem {
  private static instance: CronSubsystem | null = null

  private emitter: CronEmitter
  private metadata: EventMetadata
  private inFlight: Map<string, InFlightMonitor> = new Map()
  private monitorTimeoutMs: number = DEFAULT_MONITOR_TIMEOUT_MS
  private destroyed: boolean = false

  private constructor(emitter: CronEmitter, metadata: EventMetadata) {
    this.emitter = emitter
    this.metadata = metadata
  }

  static initialize(emitter: CronEmitter, metadata: EventMetadata): CronSubsystem {
    if (CronSubsystem.instance) {
      CronSubsystem.instance.destroy()
    }
    CronSubsystem.instance = new CronSubsystem(emitter, metadata)
    return CronSubsystem.instance
  }

  static getInstance(): CronSubsystem | null {
    return CronSubsystem.instance
  }

  /**
   * Send a cron check-in event.
   *
   * @param monitorSlug Unique identifier for this cron job (e.g., "daily-cleanup")
   * @param status Check-in status: 'in_progress', 'ok', or 'error'
   * @param options Optional: duration (ms), environment
   */
  checkIn(
    monitorSlug: string,
    status: 'ok' | 'error' | 'in_progress',
    options?: { duration?: number; environment?: string }
  ): void {
    if (this.destroyed) return

    const logger = getLogger()

    if (status === 'in_progress') {
      // Track in-flight monitor with timeout
      const existing = this.inFlight.get(monitorSlug)
      if (existing?.timeoutHandle) {
        clearTimeout(existing.timeoutHandle)
      }

      const timeoutHandle = setTimeout(() => {
        context.with(suppressTracing(context.active()), () => {
          logger.warn(`[CronSubsystem] Monitor '${monitorSlug}' timed out after ${this.monitorTimeoutMs}ms`)
          this.inFlight.delete(monitorSlug)

          // Emit an error check-in for the timeout. Same environment
          // fallback as the completion path below — a timed-out monitor
          // must not lose its environment metadata.
          const timeoutEvent: CronCheckInEvent = {
            type: 'cron_checkin',
            monitorSlug,
            status: 'error',
            timestamp: Date.now(),
            duration: this.monitorTimeoutMs,
            environment: options?.environment ?? this.metadata.environment,
            metadata: this.metadata,
          }
          this.emitter(timeoutEvent)
        })
      }, this.monitorTimeoutMs)

      if (typeof timeoutHandle === 'object' && 'unref' in timeoutHandle) {
        ;(timeoutHandle as NodeJS.Timeout).unref()
      }

      this.inFlight.set(monitorSlug, {
        monitorSlug,
        startedAt: Date.now(),
        timeoutHandle,
      })
    } else {
      // Completing a monitor — clear in-flight tracking
      const existing = this.inFlight.get(monitorSlug)
      if (existing) {
        if (existing.timeoutHandle) clearTimeout(existing.timeoutHandle)
        this.inFlight.delete(monitorSlug)
      }
    }

    const event: CronCheckInEvent = {
      type: 'cron_checkin',
      monitorSlug,
      status,
      timestamp: Date.now(),
      duration: options?.duration,
      environment: options?.environment ?? this.metadata.environment,
      metadata: this.metadata,
    }

    this.emitter(event)
    logger.info(`[CronSubsystem] Check-in: ${monitorSlug} → ${status}`)
  }

  /**
   * Handle config change.
   *
   * The crons feature toggle itself is owned by the FeatureController (it
   * initializes/resets this subsystem), but that flip travels an async void
   * path — if this instance is still alive when the diff lands, stop the
   * in-flight monitors immediately so no pending timeout can emit an error
   * check-in against a feature the control plane has already disabled.
   */
  handleConfigChange(diff: ConfigDiff, newConfig: Readonly<RemoteConfigResponse>): void {
    if (diff.featuresChanged && !newConfig.features.crons) {
      this.stop()
    }
  }

  /** Get list of in-flight monitors. */
  getInFlightMonitors(): string[] {
    return Array.from(this.inFlight.keys())
  }

  /** Stop and clean up all in-flight monitors. */
  stop(): void {
    for (const [, monitor] of this.inFlight) {
      if (monitor.timeoutHandle) clearTimeout(monitor.timeoutHandle)
    }
    this.inFlight.clear()
    getLogger().info('[CronSubsystem] Stopped')
  }

  destroy(): void {
    this.stop()
    this.destroyed = true
    CronSubsystem.instance = null
  }

  static reset(): void {
    if (CronSubsystem.instance) {
      CronSubsystem.instance.destroy()
    }
  }
}
