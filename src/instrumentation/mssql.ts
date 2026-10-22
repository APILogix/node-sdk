/**
 * Microsoft SQL Server Instrumentation — auto-instrumentation for
 * tedious and mssql drivers.
 *
 * Captures:
 * - T-SQL query execution timing
 * - Stored procedure and batch executions
 * - Target database name
 * - Sanitized T-SQL query statement
 */

import { trace, SpanKind, SpanStatusCode } from '@opentelemetry/api'
import { resolveModuleSafe, applyIdempotentPatch, sanitizeQueryStatement } from './safe-wrapper.js'
import type { MSSQLInstrumentationConfig, PrivacyCaptureConfig } from '../types/config.js'

const MSSQL_GUARD = Symbol.for('pulse-sdk.patch.mssql')

export interface MSSQLInstrumentationOptions {
  enabled: boolean
  captureQueries?: boolean
  captureParams?: boolean
}

export function createMSSQLInstrumentation(
  enabled: boolean,
  options?: Partial<MSSQLInstrumentationOptions>,
  _captureConfig?: PrivacyCaptureConfig,
): { enable: () => void; disable: () => void; teardown: () => void } | null {
  if (!enabled) return null

  const tediousModule = resolveModuleSafe('tedious')
  const Connection = tediousModule?.Connection ?? tediousModule?.default?.Connection

  if (!Connection || !Connection.prototype || typeof Connection.prototype.execSql !== 'function') {
    return null
  }

  const origExecSql = Connection.prototype.execSql
  let active = true

  applyIdempotentPatch(MSSQL_GUARD, () => {
    Connection.prototype.execSql = function pulseTediousExecSql(this: any, request: any, ...args: any[]) {
      if (!active || !request) return origExecSql.apply(this, [request, ...args])

      const tracer = trace.getTracer('@lynktrace/node-mssql')
      const rawSql = request.sqlTextOrProcedure ?? ''
      const statement = sanitizeQueryStatement(rawSql, 2048)

      const span = tracer.startSpan('mssql.query', {
        kind: SpanKind.CLIENT,
        attributes: {
          'db.system': 'mssql',
          'db.statement': options?.captureQueries !== false ? statement : undefined,
          'db.name': this.config?.options?.database ?? 'master',
        },
      })

      // Intercept request completion
      const origUserCallback = request.userCallback
      request.userCallback = function pulseTediousCallback(err: any, rowCount: any, rows: any) {
        try {
          if (err) {
            span.recordException(err instanceof Error ? err : new Error(String(err)))
            span.setStatus({ code: SpanStatusCode.ERROR, message: err.message })
          } else {
            if (rowCount != null) {
              span.setAttribute('db.mssql.rows_affected', rowCount)
            }
            span.setStatus({ code: SpanStatusCode.OK })
          }
          span.end()
        } catch {}

        if (typeof origUserCallback === 'function') {
          return origUserCallback.call(this, err, rowCount, rows)
        }
      }

      return origExecSql.apply(this, [request, ...args])
    }

    return () => {
      Connection.prototype.execSql = origExecSql
    }
  })

  return {
    enable: () => { active = true },
    disable: () => { active = false },
    teardown: () => {
      active = false
      Connection.prototype.execSql = origExecSql
    },
  }
}
