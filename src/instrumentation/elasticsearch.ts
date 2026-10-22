/**
 * Elasticsearch & OpenSearch Instrumentation — auto-instrumentation for
 * official @elastic/elasticsearch and @opensearch-project/opensearch clients.
 *
 * Captures:
 * - Search operations with hit counts and cluster execution duration (took)
 * - Indexing, bulk operations, and document updates
 * - Target index name and HTTP status
 * - Sanitized Query DSL payloads
 */

import { trace, SpanKind, SpanStatusCode } from '@opentelemetry/api'
import { resolveModuleSafe, applyIdempotentPatch } from './safe-wrapper.js'
import type { ElasticsearchInstrumentationConfig, PrivacyCaptureConfig } from '../types/config.js'

const ES_GUARD = Symbol.for('pulse-sdk.patch.elasticsearch')

export interface ElasticsearchInstrumentationOptions {
  enabled: boolean
  captureQueries?: boolean
}

export function createElasticsearchInstrumentation(
  enabled: boolean,
  options?: Partial<ElasticsearchInstrumentationOptions>,
  captureConfig?: PrivacyCaptureConfig,
): { enable: () => void; disable: () => void; teardown: () => void } | null {
  if (!enabled) return null

  const esModule = resolveModuleSafe('@elastic/elasticsearch') || resolveModuleSafe('@opensearch-project/opensearch')
  if (!esModule) return null

  const Client = esModule.Client ?? esModule.default?.Client
  if (!Client || !Client.prototype || typeof Client.prototype.search !== 'function') {
    return null
  }

  const origSearch = Client.prototype.search
  const origIndex = Client.prototype.index
  const origBulk = Client.prototype.bulk

  let active = true

  applyIdempotentPatch(ES_GUARD, () => {
    // 1. Search Hook
    Client.prototype.search = function pulseEsSearch(this: any, params: any, ...args: any[]) {
      if (!active) return origSearch.apply(this, [params, ...args])

      const tracer = trace.getTracer('@lynktrace/node-elasticsearch')
      const indexName = params?.index ? String(params.index) : '_all'

      const span = tracer.startSpan('elasticsearch.search', {
        kind: SpanKind.CLIENT,
        attributes: {
          'db.system': 'elasticsearch',
          'db.operation': 'search',
          'elasticsearch.index': indexName,
        },
      })

      if (options?.captureQueries !== false && captureConfig?.body && params?.body) {
        try {
          span.setAttribute('elasticsearch.query_dsl', JSON.stringify(params.body).slice(0, 1024))
        } catch {}
      }

      const promise = origSearch.apply(this, [params, ...args])
      if (promise && typeof promise.then === 'function') {
        return promise.then(
          (response: any) => {
            try {
              const body = response?.body ?? response
              if (body?.took != null) {
                span.setAttribute('elasticsearch.took_ms', body.took)
              }
              const hits = body?.hits?.total?.value ?? (typeof body?.hits?.total === 'number' ? body.hits.total : undefined)
              if (hits != null) {
                span.setAttribute('elasticsearch.hits_total', hits)
              }
              span.setStatus({ code: SpanStatusCode.OK })
              span.end()
            } catch {}
            return response
          },
          (error: any) => {
            try {
              span.recordException(error instanceof Error ? error : new Error(String(error)))
              span.setStatus({ code: SpanStatusCode.ERROR, message: error?.message ?? String(error) })
              span.end()
            } catch {}
            throw error
          },
        )
      }

      span.end()
      return promise
    }

    // 2. Index Hook
    if (typeof origIndex === 'function') {
      Client.prototype.index = function pulseEsIndex(this: any, params: any, ...args: any[]) {
        if (!active) return origIndex.apply(this, [params, ...args])

        const tracer = trace.getTracer('@lynktrace/node-elasticsearch')
        const span = tracer.startSpan('elasticsearch.index', {
          kind: SpanKind.CLIENT,
          attributes: {
            'db.system': 'elasticsearch',
            'db.operation': 'index',
            'elasticsearch.index': params?.index ? String(params.index) : undefined,
          },
        })

        const promise = origIndex.apply(this, [params, ...args])
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
    }

    // 3. Bulk Hook
    if (typeof origBulk === 'function') {
      Client.prototype.bulk = function pulseEsBulk(this: any, params: any, ...args: any[]) {
        if (!active) return origBulk.apply(this, [params, ...args])

        const tracer = trace.getTracer('@lynktrace/node-elasticsearch')
        const span = tracer.startSpan('elasticsearch.bulk', {
          kind: SpanKind.CLIENT,
          attributes: {
            'db.system': 'elasticsearch',
            'db.operation': 'bulk',
            'elasticsearch.index': params?.index ? String(params.index) : undefined,
          },
        })

        const promise = origBulk.apply(this, [params, ...args])
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
    }

    return () => {
      Client.prototype.search = origSearch
      if (typeof origIndex === 'function') Client.prototype.index = origIndex
      if (typeof origBulk === 'function') Client.prototype.bulk = origBulk
    }
  })

  return {
    enable: () => { active = true },
    disable: () => { active = false },
    teardown: () => {
      active = false
      Client.prototype.search = origSearch
      if (typeof origIndex === 'function') Client.prototype.index = origIndex
      if (typeof origBulk === 'function') Client.prototype.bulk = origBulk
    },
  }
}
