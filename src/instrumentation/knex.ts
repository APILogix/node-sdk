/**
 * Knex.js Instrumentation — auto-instrumentation for Knex query builder.
 */

import { trace, SpanKind, SpanStatusCode } from '@opentelemetry/api'
import { resolveModuleSafe, applyIdempotentPatch, sanitizeQueryStatement } from './safe-wrapper.js'

const KNEX_GUARD = Symbol.for('pulse-sdk.patch.knex')

export function createKnexInstrumentation(
  enabled: boolean,
): { enable: () => void; disable: () => void; teardown: () => void } | null {
  if (!enabled) return null

  const knexModule = resolveModuleSafe('knex')
  if (!knexModule) return null

  const Client = knexModule.Client ?? knexModule.default?.Client
  if (!Client || !Client.prototype || typeof Client.prototype.query !== 'function') {
    return null
  }

  const origQuery = Client.prototype.query
  let active = true

  applyIdempotentPatch(KNEX_GUARD, () => {
    Client.prototype.query = function pulseKnexQuery(this: any, connection: any, obj: any) {
      if (!active || !obj) return origQuery.apply(this, [connection, obj])

      const tracer = trace.getTracer('@lynktrace/node-knex')
      const rawSql = typeof obj === 'string' ? obj : obj.sql ?? ''
      const statement = sanitizeQueryStatement(rawSql, 2048)

      const span = tracer.startSpan('knex.query', {
        kind: SpanKind.CLIENT,
        attributes: {
          'db.system': 'knex',
          'db.statement': statement,
          'db.knex.dialect': this.dialect ?? 'unknown',
        },
      })

      const promise = origQuery.apply(this, [connection, obj])
      if (promise && typeof promise.then === 'function') {
        return promise.then(
          (res: any) => {
            try {
              span.setStatus({ code: SpanStatusCode.OK })
              span.end()
            } catch {}
            return res
          },
          (err: any) => {
            try {
              span.recordException(err instanceof Error ? err : new Error(String(err)))
              span.setStatus({ code: SpanStatusCode.ERROR, message: err?.message ?? String(err) })
              span.end()
            } catch {}
            throw err
          },
        )
      }

      span.end()
      return promise
    }

    return () => {
      Client.prototype.query = origQuery
    }
  })

  return {
    enable: () => { active = true },
    disable: () => { active = false },
    teardown: () => {
      active = false
      Client.prototype.query = origQuery
    },
  }
}
