/**
 * LoggingSubsystem — captures console.log/warn/error/info and explicit log calls.
 *
 * Behavior:
 * - Intercepts console methods based on logging.captureConsole config.
 * - Only captures configured log levels (logging.levels array).
 * - Truncates messages to logging.maxLogSize bytes.
 * - Routes LogEvent objects to the transport layer via the provided emit callback.
 * - Respects killswitch: disableLogs → detach interceptors, drain buffer.
 * - Restores original console methods on teardown.
 */

import type { LoggingConfig, ConfigDiff, RemoteConfigResponse } from '../types/config.js'
import type { LogEvent, EventMetadata } from '../types/event.js'
import { getLogger } from '../utils/logger.js'

type LogEmitter = (event: LogEvent) => void

export class LoggingSubsystem {
  private static instance: LoggingSubsystem | null = null

  private config: LoggingConfig
  private emitter: LogEmitter
  private metadata: EventMetadata

  /** Stashed original console methods — restored on teardown. */
  private originals: Map<string, (...args: unknown[]) => void> = new Map()
  private intercepted: boolean = false
  private destroyed: boolean = false

  private constructor(config: LoggingConfig, emitter: LogEmitter, metadata: EventMetadata) {
    this.config = { ...config }
    this.emitter = emitter
    this.metadata = metadata
  }

  static initialize(config: LoggingConfig, emitter: LogEmitter, metadata: EventMetadata): LoggingSubsystem {
    if (LoggingSubsystem.instance) {
      LoggingSubsystem.instance.destroy()
    }
    LoggingSubsystem.instance = new LoggingSubsystem(config, emitter, metadata)
    return LoggingSubsystem.instance
  }

  static getInstance(): LoggingSubsystem | null {
    return LoggingSubsystem.instance
  }

  /** Start intercepting console methods. */
  start(): void {
    if (this.intercepted || this.destroyed) return
    if (!this.config.enabled) return

    if (this.config.captureConsole) {
      this.installInterceptors()
    }

    getLogger().info('[LoggingSubsystem] Started')
  }

  /** Stop intercepting and restore original console methods. */
  stop(): void {
    this.removeInterceptors()
    getLogger().info('[LoggingSubsystem] Stopped')
  }

  /** Explicitly capture a log event. */
  captureLog(level: string, message: string, args?: readonly unknown[]): void {
    if (this.destroyed || !this.config.enabled) return
    if (!this.isLevelAllowed(level)) return

    const truncated = this.truncateMessage(message)

    const event: LogEvent = {
      type: 'log',
      level,
      message: truncated,
      timestamp: Date.now(),
      args: args?.length ? args.slice(0, 10) : undefined,
      metadata: this.metadata,
    }

    this.emitter(event)
  }

  /** Handle config change — hot-swap logging config. */
  handleConfigChange(_diff: ConfigDiff, newConfig: Readonly<RemoteConfigResponse>): void {
    if (this.destroyed) return

    const newLogging = newConfig.logging
    const oldEnabled = this.config.enabled && this.config.captureConsole
    const newEnabled = newLogging.enabled && newLogging.captureConsole

    this.config = { ...newLogging }

    if (!oldEnabled && newEnabled) {
      this.installInterceptors()
    } else if (oldEnabled && !newEnabled) {
      this.removeInterceptors()
    }
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  private isLevelAllowed(level: string): boolean {
    return this.config.levels.includes(level)
  }

  private truncateMessage(message: string): string {
    if (message.length <= this.config.maxLogSize) return message
    return message.slice(0, this.config.maxLogSize) + '… [truncated]'
  }

  private installInterceptors(): void {
    if (this.intercepted) return

    const levels = ['log', 'info', 'warn', 'error', 'debug'] as const

    for (const level of levels) {
      const original = console[level]
      if (typeof original !== 'function') continue

      this.originals.set(level, original.bind(console))

      console[level] = (...args: unknown[]) => {
        // Always call the original first
        original.apply(console, args)

        // Capture if level is allowed
        const mappedLevel = level === 'log' ? 'info' : level
        if (this.isLevelAllowed(mappedLevel) && !this.destroyed) {
          try {
            const message = args
              .map(a => (typeof a === 'string' ? a : JSON.stringify(a)))
              .join(' ')
            this.captureLog(mappedLevel, message, args)
          } catch {
            // Never throw in console interceptor
          }
        }
      }
    }

    this.intercepted = true
  }

  private removeInterceptors(): void {
    if (!this.intercepted) return

    for (const [level, original] of this.originals) {
      ;(console as unknown as Record<string, unknown>)[level] = original
    }
    this.originals.clear()
    this.intercepted = false
  }

  destroy(): void {
    this.stop()
    this.destroyed = true
    LoggingSubsystem.instance = null
  }

  static reset(): void {
    if (LoggingSubsystem.instance) {
      LoggingSubsystem.instance.destroy()
    }
  }
}
