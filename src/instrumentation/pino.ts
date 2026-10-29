/**
 * Pino Logging Integration for LynkTrace Telemetry.
 *
 * Provides:
 * 1. `createPinoStream()`: A high-throughput Writable destination stream for Pino.
 * 2. `pinoTraceMixin()`: Fast zero-overhead mixin for automatic trace and span ID correlation.
 *
 * Usage:
 *   import pino from 'pino'
 *   import { createPinoStream, pinoTraceMixin } from '@lynktrace/node'
 *
 *   const logger = pino({
 *     mixin: pinoTraceMixin,
 *   }, pino.multistream([
 *     { stream: process.stdout },
 *     { stream: createPinoStream() }
 *   ]))
 */

import { Writable } from 'node:stream'
import { captureLog } from '../capture/captureLog.js'
import { getTraceId, getSpanId } from '../core/context.js'

const PINO_LEVEL_MAP: Readonly<Record<number, string>> = Object.freeze({
  10: 'trace',
  20: 'debug',
  30: 'info',
  40: 'warning',
  50: 'error',
  60: 'fatal',
})

export interface LynkTracePinoOptions {
  /** Minimum severity level to ingest */
  level?: string
}

/**
 * Pino mixin function for automatic trace correlation.
 * Injects `trace_id` and `span_id` directly into Pino structured log records.
 */
export function pinoTraceMixin(): Record<string, string> {
  const traceId = getTraceId()
  const spanId = getSpanId()
  const result: Record<string, string> = {}
  if (traceId) {
    result['trace_id'] = traceId
    result['traceId'] = traceId
  }
  if (spanId) {
    result['span_id'] = spanId
    result['spanId'] = spanId
  }
  return result
}

export class LynkTracePinoStream extends Writable {
  constructor(_options: LynkTracePinoOptions = {}) {
    super({ objectMode: true })
  }

  _write(chunk: any, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    try {
      let record: any = null

      if (typeof chunk === 'string') {
        const trimmed = chunk.trim()
        if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
          record = JSON.parse(trimmed)
        }
      } else if (Buffer.isBuffer(chunk)) {
        const str = chunk.toString('utf-8').trim()
        if (str.startsWith('{') && str.endsWith('}')) {
          record = JSON.parse(str)
        }
      } else if (typeof chunk === 'object' && chunk !== null) {
        record = chunk
      }

      if (record && typeof record === 'object') {
        const rawLevel = record.level
        let levelStr = 'info'
        if (typeof rawLevel === 'number') {
          levelStr = PINO_LEVEL_MAP[rawLevel] || (rawLevel >= 50 ? 'error' : rawLevel >= 40 ? 'warning' : 'info')
        } else if (typeof rawLevel === 'string') {
          levelStr = rawLevel.toLowerCase() === 'warn' ? 'warning' : rawLevel.toLowerCase()
        }

        const message = String(record.msg || record.message || '')
        const { level: _l, msg: _m, message: _msg, time: _t, pid: _p, hostname: _h, ...meta } = record

        if (Object.keys(meta).length > 0) {
          captureLog(levelStr as any, message, meta)
        } else {
          captureLog(levelStr as any, message)
        }
      }
    } catch {
      // Best-effort ingestion: never break application log stream
    }

    callback()
  }
}

export function createPinoStream(options?: LynkTracePinoOptions): LynkTracePinoStream {
  return new LynkTracePinoStream(options)
}
