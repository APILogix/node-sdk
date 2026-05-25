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
import { getRequestContext, getSpanId, getTraceId } from '../core/context.js'

type LogEmitter = (event: LogEvent) => void

type ConsoleMethod = (...args: unknown[]) => void

/**
 * Marker placed on every wrapper function we install. Used to detect
 * already-wrapped console methods on reinit so we don't double-wrap.
 */
const WRAPPER_MARKER = Symbol.for('pulse-sdk.logging-subsystem.wrapper')

interface MarkedWrapper extends ConsoleMethod {
  [WRAPPER_MARKER]?: true
}

export class LoggingSubsystem {
  private static instance: LoggingSubsystem | null = null

  /**
   * Module-local re-entry guard for the console wrapper. Set to true
   * while we're inside `captureLog` (or its emitter), prevents the
   * subsystem from recursing if any code in the capture path itself
   * writes to a wrapped console method.
   */
  private static captureReentry: boolean = false

  private config: LoggingConfig
  private emitter: LogEmitter
  private metadata: EventMetadata

  /** Stashed original console methods — restored on teardown. */
  private originals: Map<string, ConsoleMethod> = new Map()
  private wrappers: Map<string, ConsoleMethod> = new Map()
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
      requestId: getRequestContext()?.requestId,
      traceId: getTraceId(),
      spanId: getSpanId(),
      metadata: this.metadata,
    }

    this.emitter(event)
  }

  /**
   * Handle config change — hot-swap logging config.
   *
   * The wire schema no longer contains a `logging` block; init wires a
   * synthesized config (SDK defaults + `features.logging` mirror) onto
   * the config object passed here. We cast through `unknown` because the
   * public `RemoteConfigResponse` type intentionally doesn't expose this
   * legacy shape.
   */
  handleConfigChange(_diff: ConfigDiff, newConfig: Readonly<RemoteConfigResponse>): void {
    if (this.destroyed) return

    const synthesized = (newConfig as unknown as { logging?: import('../types/config.js').LoggingConfig }).logging
    if (!synthesized) return

    const oldEnabled = this.config.enabled && this.config.captureConsole
    const newEnabled = synthesized.enabled && synthesized.captureConsole

    this.config = { ...synthesized }

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
    const consoleAny = console as unknown as Record<string, ConsoleMethod>
    const logger = getLogger()

    for (const level of levels) {
      const current = consoleAny[level]
      if (typeof current !== 'function') continue

      // If the slot already holds one of our markers, the previous SDK
      // lifetime didn't fully restore. Refuse to chain a second wrapper
      // — a previous version of this code chained, which on each reinit
      // doubled the number of capture calls per console invocation. The
      // safe behaviour is to refuse: the existing wrapper still works,
      // and `removeInterceptors()` of *this* instance cannot recover
      // the original anyway. Operators should fix the root cause (a
      // missed shutdown) rather than have us silently multiply work.
      if (isMarkedWrapper(current)) {
        logger.warn(
          `[LoggingSubsystem] console.${level} is already wrapped by Pulse SDK; ` +
            `skipping install (previous SDK instance did not tear down)`,
        )
        continue
      }

      const original: ConsoleMethod = current.bind(console)
      this.originals.set(level, original)

      const wrapper: MarkedWrapper = (...args: unknown[]) => {
        // Always call the original first so the user's console output is
        // never delayed or lost by our work.
        original.apply(console, args)

        // Re-entry guard. Without this, any console.* call from inside
        // `this.emitter(...)` (e.g., a plugin that logs during processing,
        // or the SDK logger ever regressing back to console.* output)
        // would recurse here, capturing infinitely.
        if (LoggingSubsystem.captureReentry) return
        LoggingSubsystem.captureReentry = true

        try {
          // Capture if level is allowed.
          const mappedLevel = level === 'log' ? 'info' : level
          if (this.isLevelAllowed(mappedLevel) && !this.destroyed) {
            const message = args
              .map(a => (typeof a === 'string' ? a : safeStringify(a)))
              .join(' ')
            this.captureLog(mappedLevel, message, args)
          }
        } catch {
          // Never throw in console interceptor.
        } finally {
          LoggingSubsystem.captureReentry = false
        }
      }
      wrapper[WRAPPER_MARKER] = true
      this.wrappers.set(level, wrapper)
      consoleAny[level] = wrapper
    }

    this.intercepted = true
  }

  private removeInterceptors(): void {
    if (!this.intercepted) return

    const consoleAny = console as unknown as Record<string, ConsoleMethod>
    for (const [level, original] of this.originals) {
      const current = consoleAny[level]
      const wrapper = this.wrappers.get(level)

      // Only restore if the slot still holds OUR wrapper. If something else
      // wrapped on top of us after install, leave that wrapper alone — its
      // owner is responsible for calling through to ours.
      if (current === wrapper) {
        consoleAny[level] = original
      }
    }
    this.originals.clear()
    this.wrappers.clear()
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

function isMarkedWrapper(fn: ConsoleMethod): fn is MarkedWrapper {
  return (fn as MarkedWrapper)[WRAPPER_MARKER] === true
}

/**
 * Stringify an arbitrary value safely.
 * Returns "[Circular]" for cycles and "[Unserializable]" for any other
 * JSON.stringify failure. Never throws.
 */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch (err) {
    if (err instanceof TypeError && err.message.includes('circular')) {
      return '[Circular]'
    }
    return '[Unserializable]'
  }
}
