/**
 * Structured logging subsystem. Remote config owns whether logging exists;
 * local constants define implementation-only console and size behavior.
 */

import type { RemoteConfigResponse } from '../types/config.js'
import type { LogEvent, EventMetadata } from '../types/event.js'
import { LOGGING_DEFAULTS } from '../constants/internal-defaults.js'
import { getLogger } from '../utils/logger.js'
import { getRequestContext, getSpanId, getTraceId } from '../core/context.js'
import { SecurityScrubber } from '../processors/security-scrubber.js'
import { EntitlementGate } from '../core/entitlement-gate.js'
import { isSdkConsoleBypass } from '../utils/sdk-console.js'

type LogEmitter = (event: LogEvent) => void
type ConsoleMethod = (...args: unknown[]) => void

interface LoggingRuntimeConfig {
  readonly enabled: boolean
  readonly captureConsole: boolean
  readonly levels: readonly string[]
  readonly maxLogSize: number
}

const WRAPPER_MARKER = Symbol.for('pulse-sdk.logging-subsystem.wrapper')

interface MarkedWrapper extends ConsoleMethod {
  [WRAPPER_MARKER]?: true
}

export class LoggingSubsystem {
  private static instance: LoggingSubsystem | null = null
  private static captureReentry = false

  private config: LoggingRuntimeConfig
  private readonly emitter: LogEmitter
  private metadata: EventMetadata
  private readonly originals = new Map<string, ConsoleMethod>()
  private readonly wrappers = new Map<string, ConsoleMethod>()
  private intercepted = false
  private destroyed = false

  private constructor(config: Readonly<RemoteConfigResponse>, emitter: LogEmitter, metadata: EventMetadata) {
    this.config = resolveLoggingConfig(config)
    this.emitter = emitter
    this.metadata = metadata
  }

  static initialize(
    config: Readonly<RemoteConfigResponse>,
    emitter: LogEmitter,
    metadata: EventMetadata,
  ): LoggingSubsystem {
    LoggingSubsystem.instance?.destroy()
    LoggingSubsystem.instance = new LoggingSubsystem(config, emitter, metadata)
    return LoggingSubsystem.instance
  }

  static getInstance(): LoggingSubsystem | null {
    return LoggingSubsystem.instance
  }

  updateMetadata(metadata: EventMetadata): void {
    this.metadata = metadata
  }

  start(): void {
    if (this.intercepted || this.destroyed || !this.config.enabled) return
    if (this.config.captureConsole) this.installInterceptors()
    getLogger().info('[LoggingSubsystem] Started')
  }

  stop(): void {
    this.removeInterceptors()
    getLogger().info('[LoggingSubsystem] Stopped')
  }

  captureLog(level: string, message: string, args?: readonly unknown[]): void {
    if (this.destroyed || !this.config.enabled || !EntitlementGate.isAllowed('logging') || !this.isLevelAllowed(level)) return

    const event: LogEvent = {
      type: 'log',
      level,
      message: this.truncateMessage(message),
      timestamp: Date.now(),
      args: args?.length ? this.scrubLogArgs(args.slice(0, 10)) : undefined,
      requestId: getRequestContext()?.requestId,
      traceId: getTraceId(),
      spanId: getSpanId(),
      metadata: this.metadata,
    }
    this.emitter(event)
  }

  /** Apply a validated complete snapshot selected by ConfigManager. */
  handleConfigChange(config: Readonly<RemoteConfigResponse>): void {
    if (this.destroyed) return

    const previous = this.config
    const current = resolveLoggingConfig(config)
    const wasIntercepting = previous.enabled && previous.captureConsole
    const shouldIntercept = current.enabled && current.captureConsole
    this.config = current

    if (!wasIntercepting && shouldIntercept) this.installInterceptors()
    else if (wasIntercepting && !shouldIntercept) this.removeInterceptors()
  }

  private scrubLogArgs(args: readonly unknown[]): unknown[] {
    const scrubber = SecurityScrubber.getInstance()
    if (!scrubber) return []
    return args.map(arg => scrubber.scrubValue(arg))
  }

  private isLevelAllowed(level: string): boolean {
    return this.config.levels.includes(level)
  }

  private truncateMessage(message: string): string {
    if (message.length <= this.config.maxLogSize) return message
    return `${message.slice(0, this.config.maxLogSize)}… [truncated]`
  }

  private installInterceptors(): void {
    if (this.intercepted || this.destroyed || !this.config.enabled) return

    const levels = ['log', 'info', 'warn', 'error', 'debug'] as const
    const consoleMethods = console as unknown as Record<string, ConsoleMethod>
    const logger = getLogger()

    for (const level of levels) {
      const current = consoleMethods[level]
      if (typeof current !== 'function') continue
      if (isMarkedWrapper(current)) {
        logger.warn(
          `[LoggingSubsystem] console.${level} is already wrapped by Pulse telemetry; skipping install`,
        )
        continue
      }

      const original = current.bind(console)
      this.originals.set(level, original)

      const wrapper: MarkedWrapper = (...args: unknown[]) => {
        original.apply(console, args)
        if (args.some(isSdkConsoleBypass)) return
        if (LoggingSubsystem.captureReentry) return
        LoggingSubsystem.captureReentry = true
        try {
          const mappedLevel = level === 'log' ? 'info' : level === 'warn' ? 'warning' : level
          if (this.isLevelAllowed(mappedLevel) && !this.destroyed && this.config.enabled) {
            const scrubbedArgs = this.scrubLogArgs(args)
            const message = scrubbedArgs
              .map(value => typeof value === 'string' ? value : safeStringify(value))
              .join(' ')
            this.captureLog(mappedLevel, message, scrubbedArgs)
          }
        } catch {
          // Console capture must never alter application control flow.
        } finally {
          LoggingSubsystem.captureReentry = false
        }
      }
      wrapper[WRAPPER_MARKER] = true
      this.wrappers.set(level, wrapper)
      consoleMethods[level] = wrapper
    }

    this.intercepted = true
  }

  private removeInterceptors(): void {
    if (!this.intercepted) return
    const consoleMethods = console as unknown as Record<string, ConsoleMethod>
    for (const [level, original] of this.originals) {
      if (consoleMethods[level] === this.wrappers.get(level)) consoleMethods[level] = original
    }
    this.originals.clear()
    this.wrappers.clear()
    this.intercepted = false
  }

  destroy(): void {
    this.stop()
    this.destroyed = true
    if (LoggingSubsystem.instance === this) LoggingSubsystem.instance = null
  }

  static reset(): void {
    LoggingSubsystem.instance?.destroy()
  }
}

function resolveLoggingConfig(config: Readonly<RemoteConfigResponse>): LoggingRuntimeConfig {
  return {
    enabled: config.features.logging,
    captureConsole: LOGGING_DEFAULTS.captureConsole,
    levels: LOGGING_DEFAULTS.levels,
    maxLogSize: LOGGING_DEFAULTS.maxLogSize,
  }
}

function isMarkedWrapper(fn: ConsoleMethod): fn is MarkedWrapper {
  return (fn as MarkedWrapper)[WRAPPER_MARKER] === true
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch (error) {
    return error instanceof TypeError && error.message.toLowerCase().includes('circular')
      ? '[Circular]'
      : '[Unserializable]'
  }
}
