/**
 * PostgreSQL Instrumentation — OpenTelemetry auto-instrumentation
 * wrapped with Pulse SDK guards and remote config support.
 *
 * Features:
 * - Query spans with operation name, table, and database
 * - Parameterized query capture (configurable via captureParams)
 * - Prepared statement support
 * - Connection pool monitoring (pool.total, pool.idle, pool.waiting)
 * - Rows affected tracking via responseHook
 * - Error tracking with query context
 */

import { PgInstrumentation as OTelPgInstrumentation } from '@opentelemetry/instrumentation-pg'
import type { PgInstrumentationConfig as OTelPgInstrumentationConfig } from '@opentelemetry/instrumentation-pg'
import { trace } from '@opentelemetry/api'
import { startSpan } from '../tracing/tracer.js'
import type { PrivacyCaptureConfig } from '../types/config.js'
import { createRequire } from 'node:module'

function resolvePgModule(force = false): any {
  try {
    const cwdRequire = createRequire(process.cwd() + '/package.json')
    const resolved = cwdRequire.resolve('pg')
    if (cwdRequire.cache && cwdRequire.cache[resolved]) {
      return cwdRequire.cache[resolved].exports
    }
    if (force) {
      return cwdRequire('pg')
    }
  } catch {
    try {
      const localRequire = createRequire(import.meta.url)
      const resolved = localRequire.resolve('pg')
      if (localRequire.cache && localRequire.cache[resolved]) {
        return localRequire.cache[resolved].exports
      }
      if (force) {
        return localRequire('pg')
      }
    } catch {
      return null
    }
  }
  return null
}

export interface PgInstrumentationOptions {
  enabled: boolean
  captureQueries?: boolean
  captureParams?: boolean
  requireParentSpan?: boolean
  ignoreConnectSpans?: boolean
  instrumentPool?: boolean
}

const PG_POOL_PATCH_GUARD = Symbol.for('lynktrace.pg-pool.connect-patched')
const PG_POOL_PATCH_GUARD_LEGACY = Symbol.for('pulse-sdk.pg-pool.connect-patched')

/**
 * Patch pg.Pool.prototype.connect to capture connection acquisition wait time
 * and pool saturation metrics (total, idle, waiting).
 */
export function patchPgPoolConnectOnce(force = true): void {
  const globalState = globalThis as any
  if (globalState[PG_POOL_PATCH_GUARD] || globalState[PG_POOL_PATCH_GUARD_LEGACY]) return

  try {
    const pgModule = resolvePgModule(force)
    const PoolClass = pgModule?.Pool ?? pgModule?.default?.Pool
    if (!PoolClass || !PoolClass.prototype || typeof PoolClass.prototype.connect !== 'function') return

    const origConnect = PoolClass.prototype.connect

    PoolClass.prototype.connect = function lynktracePoolConnect(this: any, callback?: any) {
      const activeSpan = trace.getActiveSpan()
      const totalCount = this.totalCount ?? 0
      const idleCount = this.idleCount ?? 0
      const waitingCount = this.waitingCount ?? 0

      const startTime = Date.now()
      const startHr = process.hrtime.bigint()

      // 1. Callback form
      if (typeof callback === 'function') {
        return origConnect.call(this, (err: any, client: any, release: any) => {
          const endHr = process.hrtime.bigint()
          const durationMs = Number(endHr - startHr) / 1e6

          if ((durationMs >= 1 || err) && activeSpan) {
            try {
              const span = startSpan('db.pool.acquire', {
                startTime,
                kind: 'client',
                attributes: {
                  'db.system': 'postgresql',
                  'db.pool.total': totalCount,
                  'db.pool.idle': idleCount,
                  'db.pool.waiting': waitingCount,
                  'db.pool.acquire_duration_ms': Math.round(durationMs * 100) / 100,
                },
              })
              if (err) {
                span.recordError(err instanceof Error ? err : new Error(String(err)))
                span.setStatus('error', err.message)
              } else {
                span.setStatus('ok')
              }
              span.end(startTime + Math.max(1, durationMs))
            } catch {}
          }

          callback(err, client, release)
        })
      }

      // 2. Promise form
      return origConnect.call(this).then(
        (client: any) => {
          const endHr = process.hrtime.bigint()
          const durationMs = Number(endHr - startHr) / 1e6

          if (durationMs >= 1 && activeSpan) {
            try {
              const span = startSpan('db.pool.acquire', {
                startTime,
                kind: 'client',
                attributes: {
                  'db.system': 'postgresql',
                  'db.pool.total': totalCount,
                  'db.pool.idle': idleCount,
                  'db.pool.waiting': waitingCount,
                  'db.pool.acquire_duration_ms': Math.round(durationMs * 100) / 100,
                },
              })
              span.setStatus('ok')
              span.end(startTime + Math.max(1, durationMs))
            } catch {}
          }
          return client
        },
        (err: any) => {
          const endHr = process.hrtime.bigint()
          const durationMs = Number(endHr - startHr) / 1e6

          if (activeSpan) {
            try {
              const span = startSpan('db.pool.acquire', {
                startTime,
                kind: 'client',
                attributes: {
                  'db.system': 'postgresql',
                  'db.pool.total': totalCount,
                  'db.pool.idle': idleCount,
                  'db.pool.waiting': waitingCount,
                  'db.pool.acquire_duration_ms': Math.round(durationMs * 100) / 100,
                },
              })
              span.recordError(err instanceof Error ? err : new Error(String(err)))
              span.setStatus('error', err.message)
              span.end(startTime + Math.max(1, durationMs))
            } catch {}
          }
          throw err
        }
      )
    }

    globalState[PG_POOL_PATCH_GUARD] = true
    globalState[PG_POOL_PATCH_GUARD_LEGACY] = true
  } catch {}
}

export function createPgInstrumentation(
  enabled: boolean,
  mergedOptions?: Partial<PgInstrumentationOptions>,
  captureConfig?: PrivacyCaptureConfig
): OTelPgInstrumentation | null {
  if (!enabled) {
    return null
  }

  // Ensure pool acquisition monitoring is installed if pg is already loaded
  if (mergedOptions?.instrumentPool !== false) {
    patchPgPoolConnectOnce(false)
  }

  const captureBody = captureConfig?.body ?? false

  const instrumentationOptions: OTelPgInstrumentationConfig = {
    enabled: true,
    enhancedDatabaseReporting: mergedOptions?.captureParams ?? mergedOptions?.captureQueries ?? captureBody,
    addSqlCommenterCommentToQueries: false,
    requireParentSpan: mergedOptions?.requireParentSpan ?? false,
    ...(mergedOptions?.ignoreConnectSpans !== undefined ? { ignoreConnectSpans: mergedOptions.ignoreConnectSpans } : {}),
    responseHook: (span, responseInfo) => {
      try {
        patchPgPoolConnectOnce(false)
        if (typeof (responseInfo.data as any)?.rowCount === 'number') {
          span.setAttribute('db.rows_affected', (responseInfo.data as any).rowCount)
        }
        const readable = span as any
        if (readable.startTime && Array.isArray(readable.startTime)) {
          const startMs = readable.startTime[0] * 1000 + readable.startTime[1] / 1e6
          const durationMs = Date.now() - startMs
          if (durationMs >= 100) {
            span.setAttribute('db.slow_query', true)
            span.setAttribute('db.slow_query_threshold_ms', 100)
          }
        }
      } catch {}
    },
  }

  return new OTelPgInstrumentation(instrumentationOptions)
}

export interface PgSpanAttributes {
  'db.system': 'postgresql'
  'db.name': string
  'db.operation': string
  'db.sql.table'?: string
  'db.statement'?: string
  'db.rows_affected'?: number
}

export { OTelPgInstrumentation }
export default createPgInstrumentation
