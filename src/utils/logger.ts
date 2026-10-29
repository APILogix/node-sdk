/**
 * SDK Logger — Enterprise non-blocking, memory-bounded diagnostic logging.
 *
 * Output strategy (post v3 fix for the console-interception feedback loop):
 *   The SDK never writes through `console.log/info/warn/error`. Those
 *   slots are intercepted by `LoggingSubsystem.installInterceptors()` to
 *   capture user logs as `log` events; if the SDK itself wrote there,
 *   every internal `logger.debug/info/warn/error` call would create a
 *   `log` event, which inside the pipeline produces more debug output,
 *   producing more `log` events — a runaway storm we observed at
 *   thousands of events per second under `setDebugMode(true)`.
 *
 *   Both loggers below write directly to `process.stdout` (info /
 *   debug / trace) or `process.stderr` (warn / error / fatal) via a
 *   non-blocking, bounded stream writer. The LoggingSubsystem's
 *   wrapper never sees these writes, so the feedback loop is broken at
 *   the source.
 *
 *   Non-blocking & Low-Memory guarantees:
 *   - Direct fast path writes when stream is healthy.
 *   - Backpressure-aware drain queue bounded to 256 entries to prevent
 *     unbounded V8 heap expansion during slow I/O pipes.
 *   - Drops low-priority diagnostic logs under pipe backpressure.
 *   - PII redaction is always applied regardless of debug mode.
 */

import { SDKError } from '../core/errors.js'
import { Severity, type SeverityLevel, doesSeverityMeetThreshold } from '../types/severity.js'
import { trace as otelTrace } from '@opentelemetry/api'

export interface Logger {
  trace?(message: string, context?: Record<string, unknown>): void
  debug(message: string, context?: Record<string, unknown>): void
  info(message: string, context?: Record<string, unknown>): void
  warn(message: string, context?: Record<string, unknown>): void
  error(message: string, context?: Record<string, unknown>): void
  fatal?(message: string, context?: Record<string, unknown>): void
}

// ─── Configuration ──────────────────────────────────────────────────────────

let debugMode = false
let logPrefix = 'Telemetry'
let minimumLogLevel: SeverityLevel = Severity.Info

/**
 * Enable or disable debug logging globally.
 * Called during SDK initialization based on `options.debug`.
 */
export function setDebugMode(enabled: boolean): void {
  debugMode = enabled
  minimumLogLevel = enabled ? Severity.Debug : Severity.Info
}

/**
 * Get whether debug mode is currently enabled.
 */
export function isDebugMode(): boolean {
  return debugMode
}

/**
 * Set the minimum SDK internal log level.
 */
export function setLogLevel(level: SeverityLevel): void {
  minimumLogLevel = level
}

/**
 * Get the current minimum log level.
 */
export function getLogLevel(): SeverityLevel {
  return minimumLogLevel
}

/**
 * Set the log prefix (defaults to 'Telemetry').
 */
export function setLogPrefix(prefix: string): void {
  logPrefix = prefix
}

/**
 * Get the current log prefix.
 */
export function getLogPrefix(): string {
  return logPrefix
}

// ─── Non-Blocking Bounded Stream Writer ─────────────────────────────────────

/**
 * Non-blocking, bounded stream drainer.
 * Prevents V8 heap memory explosion and event-loop stalls when process.stdout
 * or process.stderr is backpressured (e.g. slow pipe consumer in Docker/K8s).
 */
export class NonBlockingStreamWriter {
  private readonly getStream: () => NodeJS.WriteStream
  private readonly maxBufferSize: number
  private buffer: string[] = []
  private isDraining = false
  private droppedCount = 0

  constructor(getStream: () => NodeJS.WriteStream, maxBufferSize = 256) {
    this.getStream = getStream
    this.maxBufferSize = maxBufferSize
  }

  write(line: string, isCritical = false): void {
    const formatted = line.endsWith('\n') ? line : line + '\n'
    const stream = this.getStream()

    // If stream is healthy and buffer is empty, write directly (fast path - 0 queue overhead)
    if (!this.isDraining && this.buffer.length === 0) {
      try {
        const canContinue = stream.write(formatted)
        if (canContinue === false) {
          this.startDraining(stream)
        }
        return
      } catch {
        // Stream closed or detached - swallow silently
        return
      }
    }

    // Stream is backpressured
    if (this.buffer.length < this.maxBufferSize) {
      this.buffer.push(formatted)
    } else if (isCritical) {
      // Prioritize error/fatal logs: drop oldest item to make space
      this.buffer.shift()
      this.buffer.push(formatted)
      this.droppedCount++
    } else {
      // Drop low priority debug/info log under backpressure to protect memory
      this.droppedCount++
    }
  }

  private startDraining(stream: NodeJS.WriteStream): void {
    if (this.isDraining) return
    this.isDraining = true

    const onDrain = () => {
      this.drainChunk()
    }

    try {
      if (typeof stream.once === 'function') {
        stream.once('drain', onDrain)
      } else {
        // Fallback if not an event emitter
        setImmediate(onDrain)
      }
    } catch {
      this.isDraining = false
    }
  }

  private drainChunk(): void {
    const stream = this.getStream()
    try {
      while (this.buffer.length > 0) {
        const item = this.buffer.shift()!
        const canContinue = stream.write(item)
        if (canContinue === false) {
          // Still backpressured, re-arm drain listener
          if (typeof stream.once === 'function') {
            stream.once('drain', () => this.drainChunk())
          } else {
            setImmediate(() => this.drainChunk())
          }
          return
        }
      }
    } catch {
      this.buffer.length = 0
    } finally {
      if (this.buffer.length === 0) {
        this.isDraining = false
      }
    }
  }

  flushSync(): void {
    const stream = this.getStream()
    while (this.buffer.length > 0) {
      const item = this.buffer.shift()!
      try { stream.write(item) } catch {}
    }
    this.isDraining = false
  }

  getDroppedCount(): number {
    return this.droppedCount
  }

  getBufferSize(): number {
    return this.buffer.length
  }

  reset(): void {
    this.buffer = []
    this.isDraining = false
    this.droppedCount = 0
  }
}

export const stdoutDrainer = new NonBlockingStreamWriter(() => process.stdout, 256)
export const stderrDrainer = new NonBlockingStreamWriter(() => process.stderr, 256)

function writeStdout(line: string, isCritical = false): void {
  stdoutDrainer.write(line, isCritical)
}

function writeStderr(line: string, isCritical = true): void {
  stderrDrainer.write(line, isCritical)
}

export function getLoggerWriterStats(): { stdoutDrops: number; stderrDrops: number } {
  return {
    stdoutDrops: stdoutDrainer.getDroppedCount(),
    stderrDrops: stderrDrainer.getDroppedCount(),
  }
}

// ─── Redaction ──────────────────────────────────────────────────────────────

const SENSITIVE_KEY_PATTERN = /api[-_]?key|api[-_]?secret|authorization|cookie|token|password|secret|credential/i

export function redact(value: unknown, depth = 0, seen: WeakSet<object> = new WeakSet()): unknown {
  if (depth > 6) return '[max depth]'
  if (typeof value === 'string') return redactString(value)
  if (!value || typeof value !== 'object') return value

  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return `[Buffer:${value.byteLength}b]`
  }
  if (value instanceof Date) return value.toISOString()
  if (value instanceof RegExp) return value.toString()

  if (seen.has(value)) return '[Circular]'
  seen.add(value)

  if (Array.isArray(value)) {
    const maxItems = Math.min(value.length, 30)
    const out = new Array(maxItems)
    for (let i = 0; i < maxItems; i++) {
      out[i] = redact(value[i], depth + 1, seen)
    }
    if (value.length > maxItems) out.push(`...(+${value.length - maxItems} items)`)
    seen.delete(value)
    return out
  }

  if (value instanceof Error) {
    const errObj = value instanceof SDKError
      ? {
          name: value.name,
          message: redactString(value.message),
          code: value.code,
          context: redact(value.context, depth + 1, seen),
          stack: value.stack,
        }
      : {
          name: value.name,
          message: redactString(value.message),
          stack: value.stack,
        }
    seen.delete(value)
    return errObj
  }

  const redacted: Record<string, unknown> = {}
  const keys = Object.keys(value)
  const limit = Math.min(keys.length, 30)
  for (let i = 0; i < limit; i++) {
    const key = keys[i]!
    const nestedValue = (value as Record<string, unknown>)[key]
    redacted[key] = SENSITIVE_KEY_PATTERN.test(key)
      ? '[REDACTED]'
      : redact(nestedValue, depth + 1, seen)
  }
  if (keys.length > limit) {
    redacted['__truncatedKeys'] = keys.length - limit
  }
  seen.delete(value)
  return redacted
}

function redactString(value: string): string {
  return value
    .replace(/authorization=Bearer\s+([^&\s]+)/gi, 'authorization=Bearer [REDACTED]')
    .replace(/(api[-_]?key|token|authorization|password|secret)=([^&\s]+)/gi, '$1=[REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer [REDACTED]')
}

// ─── Formatting ─────────────────────────────────────────────────────────────

/**
 * Maximum size for a single serialized log context. Larger payloads are
 * truncated to prevent memory spikes from accidentally-large objects.
 */
const MAX_LOG_CONTEXT_BYTES = 16 * 1024 // 16 KB

function formatContext(context?: Record<string, unknown>): string {
  if (!context || Object.keys(context).length === 0) return ''

  try {
    const safe = redact(context) as Record<string, unknown>
    const serialized = JSON.stringify(safe)
    if (serialized.length > MAX_LOG_CONTEXT_BYTES) {
      const truncated = serialized.slice(0, MAX_LOG_CONTEXT_BYTES)
      return ` ${truncated}...[truncated:${serialized.length}b]`
    }
    return ' ' + serialized
  } catch {
    return ' [unserializable context]'
  }
}

function stripPrefix(message: string): string {
  if (message.startsWith(`[${logPrefix}]`)) {
    return message.slice(logPrefix.length + 2).trim()
  }
  return message.replace(/^\[(LynkTrace|Pulse|Telemetry|APM|SDK)\]\s*/i, '').trim()
}

// ─── Console Logger (Standard Pretty / Dev output) ─────────────────────────

export const consoleLogger: Logger = {
  trace(message: string, context?: Record<string, unknown>): void {
    if (!doesSeverityMeetThreshold(Severity.Debug, minimumLogLevel)) return
    writeStdout(`[${logPrefix}] TRACE: ${stripPrefix(message)}${formatContext(context)}`, false)
  },

  debug(message: string, context?: Record<string, unknown>): void {
    if (!doesSeverityMeetThreshold(Severity.Debug, minimumLogLevel)) return
    writeStdout(`[${logPrefix}] DEBUG: ${stripPrefix(message)}${formatContext(context)}`, false)
  },

  info(message: string, context?: Record<string, unknown>): void {
    if (!doesSeverityMeetThreshold(Severity.Info, minimumLogLevel)) return
    writeStdout(`[${logPrefix}] INFO: ${stripPrefix(message)}${formatContext(context)}`, false)
  },

  warn(message: string, context?: Record<string, unknown>): void {
    if (!doesSeverityMeetThreshold(Severity.Warning, minimumLogLevel)) return
    writeStderr(`[${logPrefix}] WARN: ${stripPrefix(message)}${formatContext(context)}`, true)
  },

  error(message: string, context?: Record<string, unknown>): void {
    if (!doesSeverityMeetThreshold(Severity.Error, minimumLogLevel)) return
    writeStderr(`[${logPrefix}] ERROR: ${stripPrefix(message)}${formatContext(context)}`, true)
  },

  fatal(message: string, context?: Record<string, unknown>): void {
    if (!doesSeverityMeetThreshold(Severity.Fatal, minimumLogLevel)) return
    writeStderr(`[${logPrefix}] FATAL: ${stripPrefix(message)}${formatContext(context)}`, true)
  },
}

// ─── Structured JSON Logger (Production-grade OpenTelemetry / ECS) ─────────

/**
 * Get active trace context from the OTel API for log correlation.
 * Returns traceId and spanId if a span is active, otherwise undefined.
 */
function getActiveTraceContext(): { traceId?: string; spanId?: string } {
  try {
    const activeSpan = otelTrace.getActiveSpan()
    if (activeSpan) {
      const ctx = activeSpan.spanContext()
      return { traceId: ctx.traceId, spanId: ctx.spanId }
    }
  } catch {
    // OTel not available or no active span — expected
  }
  return {}
}

const SEVERITY_NUMBER_MAP: Readonly<Record<string, number>> = Object.freeze({
  trace: 1,
  debug: 5,
  info: 9,
  warn: 13,
  warning: 13,
  error: 17,
  fatal: 21,
})

/**
 * Structured JSON logger — emits newline-delimited JSON (NDJSON) suitable
 * for production log aggregation systems (ELK, Datadog, CloudWatch, etc.).
 *
 * Every log entry includes:
 * - ISO timestamp + timestamp_ms
 * - Log level & OpenTelemetry severity number
 * - Message
 * - Active traceId/spanId (if OTel tracing is active)
 * - SDK prefix tag
 * - Redacted structured context
 */
export const jsonLogger: Logger = {
  trace(message: string, context?: Record<string, unknown>): void {
    if (!doesSeverityMeetThreshold(Severity.Debug, minimumLogLevel)) return
    emitJsonLog('trace', message, context)
  },

  debug(message: string, context?: Record<string, unknown>): void {
    if (!doesSeverityMeetThreshold(Severity.Debug, minimumLogLevel)) return
    emitJsonLog('debug', message, context)
  },

  info(message: string, context?: Record<string, unknown>): void {
    if (!doesSeverityMeetThreshold(Severity.Info, minimumLogLevel)) return
    emitJsonLog('info', message, context)
  },

  warn(message: string, context?: Record<string, unknown>): void {
    if (!doesSeverityMeetThreshold(Severity.Warning, minimumLogLevel)) return
    emitJsonLog('warn', message, context)
  },

  error(message: string, context?: Record<string, unknown>): void {
    if (!doesSeverityMeetThreshold(Severity.Error, minimumLogLevel)) return
    emitJsonLog('error', message, context)
  },

  fatal(message: string, context?: Record<string, unknown>): void {
    if (!doesSeverityMeetThreshold(Severity.Fatal, minimumLogLevel)) return
    emitJsonLog('fatal', message, context)
  },
}

function emitJsonLog(
  level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal',
  message: string,
  context?: Record<string, unknown>,
): void {
  const trace = getActiveTraceContext()
  const now = new Date()

  const entry: Record<string, unknown> = {
    timestamp: now.toISOString(),
    timestamp_ms: now.getTime(),
    level,
    severity_number: SEVERITY_NUMBER_MAP[level] ?? 9,
    logger: logPrefix,
    message: stripPrefix(message),
  }

  // Inject trace correlation (both OpenTelemetry trace_id and dot notation for legacy)
  if (trace.traceId) {
    entry['trace.id'] = trace.traceId
    entry['trace_id'] = trace.traceId
  }
  if (trace.spanId) {
    entry['span.id'] = trace.spanId
    entry['span_id'] = trace.spanId
  }

  // Merge redacted context — bounded so a single oversized log entry can't
  // OOM the process.
  if (context && Object.keys(context).length > 0) {
    try {
      const safe = redact(context) as Record<string, unknown>
      const serialized = JSON.stringify(safe)
      if (serialized.length > MAX_LOG_CONTEXT_BYTES) {
        entry['context'] = '[truncated]'
        entry['contextSize'] = serialized.length
      } else {
        entry['context'] = safe
      }
    } catch {
      entry['context'] = '[unserializable]'
    }
  }

  const isCritical = level === 'error' || level === 'fatal' || level === 'warn'
  const writer = isCritical ? writeStderr : writeStdout

  try {
    writer(JSON.stringify(entry), isCritical)
  } catch {
    // Fallback if JSON.stringify fails on the entry itself
    writer(`{"timestamp":"${entry['timestamp']}","level":"${level}","message":"${message}","error":"log_serialization_failed"}`, isCritical)
  }
}

// ─── Log Format Configuration ───────────────────────────────────────────────

export type LogFormat = 'text' | 'json'

let currentLogFormat: LogFormat = 'text'

/**
 * Set the log output format.
 * 'text' = Sentry-style prefixed console output (default, good for dev)
 * 'json' = NDJSON structured output (production, log aggregation)
 */
export function setLogFormat(format: LogFormat): void {
  currentLogFormat = format
  activeLogger = format === 'json' ? jsonLogger : consoleLogger
}

/**
 * Get the current log format.
 */
export function getLogFormat(): LogFormat {
  return currentLogFormat
}

// ─── Active Logger Management ───────────────────────────────────────────────

let activeLogger: Logger = consoleLogger

/**
 * Replace the active logger with a custom implementation.
 * Pass undefined/null to restore the default console logger.
 */
export function setLogger(logger: Logger | undefined | null): void {
  activeLogger = logger ?? (currentLogFormat === 'json' ? jsonLogger : consoleLogger)
}

/**
 * Get the active logger instance.
 */
export function getLogger(): Logger {
  return activeLogger
}
