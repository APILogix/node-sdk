/**
 * Apache Cassandra / ScyllaDB Instrumentation — auto-instrumentation for
 * the official DataStax cassandra-driver.
 *
 * Captures:
 * - CQL execution timing (client.execute)
 * - CQL batch operations (client.batch)
 * - Sanitized CQL statement
 * - Target keyspace and consistency level
 * - Coordinator node IP and rows returned
 */

import { trace, SpanKind, SpanStatusCode } from '@opentelemetry/api'
import { resolveModuleSafe, applyIdempotentPatch, sanitizeQueryStatement } from './safe-wrapper.js'
import type { CassandraInstrumentationConfig, PrivacyCaptureConfig } from '../types/config.js'

const CASSANDRA_GUARD = Symbol.for('pulse-sdk.patch.cassandra')

export interface CassandraInstrumentationOptions {
  enabled: boolean
  captureQueries?: boolean
  captureParams?: boolean
}

export function createCassandraInstrumentation(
  enabled: boolean,
  options?: Partial<CassandraInstrumentationOptions>,
  _captureConfig?: PrivacyCaptureConfig,
): { enable: () => void; disable: () => void; teardown: () => void } | null {
  if (!enabled) return null

  const cassandraModule = resolveModuleSafe('cassandra-driver')
  if (!cassandraModule) return null

  const Client = cassandraModule.Client ?? cassandraModule.default?.Client
  if (!Client || !Client.prototype || typeof Client.prototype.execute !== 'function') {
    return null
  }

  const origExecute = Client.prototype.execute
  const origBatch = Client.prototype.batch

  let active = true

  applyIdempotentPatch(CASSANDRA_GUARD, () => {
    Client.prototype.execute = function pulseCassandraExecute(
      this: any,
      query: string,
      params?: any,
      execOptions?: any,
      callback?: any,
    ) {
      if (!active) {
        return origExecute.apply(this, [query, params, execOptions, callback])
      }

      const tracer = trace.getTracer('@lynktrace/node-cassandra')
      const keyspace = this.keyspace ?? execOptions?.keyspace ?? 'system'
      const statement = sanitizeQueryStatement(query, 2048)

      const span = tracer.startSpan('cassandra.execute', {
        kind: SpanKind.CLIENT,
        attributes: {
          'db.system': 'cassandra',
          'db.cassandra.keyspace': keyspace,
          'db.statement': options?.captureQueries !== false ? statement : undefined,
          'db.cassandra.consistency_level': execOptions?.consistency != null ? String(execOptions.consistency) : undefined,
        },
      })

      // Normalize callback vs promise
      const actualCallback = typeof execOptions === 'function' ? execOptions : callback
      if (typeof actualCallback === 'function') {
        const wrappedCb = (err: any, result: any) => {
          try {
            if (err) {
              span.recordException(err instanceof Error ? err : new Error(String(err)))
              span.setStatus({ code: SpanStatusCode.ERROR, message: err.message })
            } else {
              if (result?.info?.queriedHost) {
                span.setAttribute('db.cassandra.coordinator.ip', String(result.info.queriedHost))
              }
              if (result?.rowLength != null) {
                span.setAttribute('db.cassandra.rows_count', result.rowLength)
              }
              span.setStatus({ code: SpanStatusCode.OK })
            }
            span.end()
          } catch {}
          actualCallback(err, result)
        }

        if (typeof execOptions === 'function') {
          return origExecute.call(this, query, params, wrappedCb)
        }
        return origExecute.call(this, query, params, execOptions, wrappedCb)
      }

      // Promise form
      const promise = origExecute.apply(this, [query, params, execOptions])
      if (promise && typeof promise.then === 'function') {
        return promise.then(
          (result: any) => {
            try {
              if (result?.info?.queriedHost) {
                span.setAttribute('db.cassandra.coordinator.ip', String(result.info.queriedHost))
              }
              if (result?.rowLength != null) {
                span.setAttribute('db.cassandra.rows_count', result.rowLength)
              }
              span.setStatus({ code: SpanStatusCode.OK })
              span.end()
            } catch {}
            return result
          },
          (err: any) => {
            try {
              span.recordException(err instanceof Error ? err : new Error(String(err)))
              span.setStatus({ code: SpanStatusCode.ERROR, message: err.message })
              span.end()
            } catch {}
            throw err
          },
        )
      }

      span.end()
      return promise
    }

    if (typeof origBatch === 'function') {
      Client.prototype.batch = function pulseCassandraBatch(this: any, queries: any[], batchOptions?: any, callback?: any) {
        if (!active) {
          return origBatch.apply(this, [queries, batchOptions, callback])
        }

        const tracer = trace.getTracer('@lynktrace/node-cassandra')
        const span = tracer.startSpan('cassandra.batch', {
          kind: SpanKind.CLIENT,
          attributes: {
            'db.system': 'cassandra',
            'db.cassandra.keyspace': this.keyspace ?? 'system',
            'db.cassandra.batch_size': Array.isArray(queries) ? queries.length : 0,
          },
        })

        const actualCallback = typeof batchOptions === 'function' ? batchOptions : callback
        if (typeof actualCallback === 'function') {
          const wrappedCb = (err: any, result: any) => {
            try {
              if (err) {
                span.recordException(err instanceof Error ? err : new Error(String(err)))
                span.setStatus({ code: SpanStatusCode.ERROR, message: err.message })
              } else {
                span.setStatus({ code: SpanStatusCode.OK })
              }
              span.end()
            } catch {}
            actualCallback(err, result)
          }
          if (typeof batchOptions === 'function') {
            return origBatch.call(this, queries, wrappedCb)
          }
          return origBatch.call(this, queries, batchOptions, wrappedCb)
        }

        const promise = origBatch.apply(this, [queries, batchOptions])
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
                span.setStatus({ code: SpanStatusCode.ERROR, message: err.message })
                span.end()
              } catch {}
              throw err
            },
          )
        }

        span.end()
        return promise
      }
    }

    return () => {
      Client.prototype.execute = origExecute
      if (typeof origBatch === 'function') {
        Client.prototype.batch = origBatch
      }
    }
  })

  return {
    enable: () => { active = true },
    disable: () => { active = false },
    teardown: () => {
      active = false
      Client.prototype.execute = origExecute
      if (typeof origBatch === 'function') {
        Client.prototype.batch = origBatch
      }
    },
  }
}
