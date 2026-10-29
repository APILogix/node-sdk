/**
 * Winston Logging Integration for LynkTrace Telemetry.
 *
 * Provides an enterprise Winston transport that automatically:
 * 1. Correlates active OpenTelemetry traceId and spanId into the Winston info object.
 * 2. Bridges Winston logs into the LynkTrace LoggingSubsystem non-blockingly.
 * 3. Does not block the host application event loop or allocate unbounded memory.
 *
 * Usage:
 *   import winston from 'winston'
 *   import { createWinstonTransport } from '@lynktrace/node'
 *
 *   const logger = winston.createLogger({
 *     transports: [
 *       new winston.transports.Console(),
 *       createWinstonTransport({ level: 'info' })
 *     ]
 *   })
 */

import { Writable } from 'node:stream'
import { captureLog } from '../capture/captureLog.js'
import { getTraceId, getSpanId } from '../core/context.js'

export interface LynkTraceWinstonOptions {
  /** Minimum log level to capture (default: 'info') */
  level?: string
  /** Whether transport is silent / disabled */
  silent?: boolean
}

export class LynkTraceWinstonTransport extends Writable {
  public readonly name = 'lynktrace'
  public level: string
  public silent: boolean

  constructor(options: LynkTraceWinstonOptions = {}) {
    super({ objectMode: true })
    this.level = options.level ?? 'info'
    this.silent = options.silent ?? false
  }

  log(info: any, next?: () => void): void {
    if (this.silent) {
      if (typeof next === 'function') next()
      return
    }

    try {
      // Auto-correlate active distributed trace context
      const traceId = getTraceId()
      const spanId = getSpanId()
      if (traceId && info && typeof info === 'object') {
        if (!info.traceId && !info['trace.id'] && !info.trace_id) {
          info.traceId = traceId
        }
      }
      if (spanId && info && typeof info === 'object') {
        if (!info.spanId && !info['span.id'] && !info.span_id) {
          info.spanId = spanId
        }
      }

      if (info && typeof info === 'object') {
        const level = String(info.level || 'info')
        const message = String(info.message || '')
        const { level: _l, message: _m, ...meta } = info

        if (Object.keys(meta).length > 0) {
          captureLog(level as any, message, meta)
        } else {
          captureLog(level as any, message)
        }
      } else if (typeof info === 'string') {
        captureLog('info', info)
      }
    } catch {
      // Never throw into application logging stream
    }

    if (typeof next === 'function') next()
  }

  _write(chunk: any, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.log(chunk, callback)
  }
}

export function createWinstonTransport(options?: LynkTraceWinstonOptions): LynkTraceWinstonTransport {
  return new LynkTraceWinstonTransport(options)
}
