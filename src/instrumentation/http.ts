/**
 * HTTP Client Instrumentation — automatically traces outbound HTTP/HTTPS requests.
 *
 * Wraps Node.js native http.request and https.request to:
 * - Create child spans for each outbound HTTP call
 * - Inject W3C trace context headers (traceparent/tracestate)
 * - Record request/response attributes per OTel semantic conventions
 * - Capture errors and timeouts
 * - Add breadcrumbs for each outbound call
 *
 * Usage:
 *   import { instrumentHttpClient } from '@vikasbaplawat1/pulse-sdk'
 *   instrumentHttpClient() // call once during app startup
 */

import http from 'node:http'
import https from 'node:https'
import { startSpan } from '../tracing/tracer.js'
import { injectTraceContext } from '../tracing/context-propagation.js'
import { addBreadcrumb, getRequestContext } from '../core/context.js'
import { getLogger } from '../utils/logger.js'
import { client } from '../core/client.js'

let instrumented = false

/**
 * Patch Node.js http/https modules to automatically trace outbound requests.
 * Idempotent — safe to call multiple times.
 */
export function instrumentHttpClient(): void {
  if (instrumented) return
  instrumented = true

  const logger = getLogger()

  patchModule(http, 'http')
  patchModule(https, 'https')

  logger.info('HTTP client instrumentation enabled')
}

function patchModule(mod: typeof http | typeof https, scheme: string): void {
  const originalRequest = mod.request

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(mod as any).request = function patchedRequest(
    ...args: unknown[]
  ): http.ClientRequest {
    const logger = getLogger()
    const startTime = Date.now()

    // Extract URL info from arguments
    const urlInfo = extractUrlInfo(args, scheme)

    // Self-request guard: skip instrumentation for SDK's own ingestion calls
    // to prevent recursive spans that inflate trace data
    if (client.initialized && isSdkInternalRequest(urlInfo.fullUrl)) {
      return (originalRequest as any).apply(mod, args) as http.ClientRequest
    }

    const spanName = `HTTP ${urlInfo.method} ${urlInfo.hostname}${urlInfo.path}`

    // Start a trace span for this outbound request
    const span = startSpan(spanName, {
      attributes: {
        'http.method': urlInfo.method,
        'http.url': urlInfo.fullUrl,
        'http.target': urlInfo.path,
        'http.host': urlInfo.hostname,
        'http.scheme': scheme,
        'span.kind': 'CLIENT',
      },
    })

    // Inject trace context into outgoing headers
    const headers: Record<string, string> = {}
    injectTraceContext(headers)

    // Merge injected headers into the request options
    if (typeof args[0] === 'object' && !(args[0] instanceof URL)) {
      const opts = args[0] as http.RequestOptions
      opts.headers = { ...opts.headers, ...headers }
    } else if (typeof args[1] === 'object' && typeof args[1] !== 'function') {
      const opts = args[1] as http.RequestOptions
      opts.headers = { ...opts.headers, ...headers }
    }

    let req: http.ClientRequest

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      req = (originalRequest as any).apply(mod, args) as http.ClientRequest
    } catch (err) {
      if (err instanceof Error) {
        span.recordError(err)
      }
      span.setStatus('error', 'Request creation failed')
      span.end()
      throw err
    }

    // Track response
    req.on('response', (res: http.IncomingMessage) => {
      const statusCode = res.statusCode ?? 0
      const latency = Date.now() - startTime

      span.setAttribute('http.status_code', statusCode)
      span.setAttribute('http.response.status_code', statusCode)
      span.setStatus(statusCode >= 400 ? 'error' : 'ok')
      span.end()

      // Add breadcrumb
      try {
        addBreadcrumb({
          category: 'http',
          message: `${urlInfo.method} ${urlInfo.fullUrl} [${statusCode}]`,
          level: statusCode >= 400 ? 'error' : 'info',
          type: 'http',
          data: {
            method: urlInfo.method,
            url: urlInfo.fullUrl,
            statusCode,
            duration: latency,
            direction: 'outbound',
          },
        })
      } catch {
        // Breadcrumb failures are non-critical
      }

      logger.debug('Outbound HTTP request completed', {
        method: urlInfo.method,
        url: urlInfo.fullUrl,
        statusCode,
        latencyMs: latency,
        traceId: span.traceId,
        spanId: span.spanId,
      })
    })

    // Track errors
    req.on('error', (err: Error) => {
      span.recordError(err)
      span.setStatus('error', err.message)
      span.end()

      try {
        addBreadcrumb({
          category: 'http',
          message: `${urlInfo.method} ${urlInfo.fullUrl} FAILED: ${err.message}`,
          level: 'error',
          type: 'http',
          data: {
            method: urlInfo.method,
            url: urlInfo.fullUrl,
            error: err.message,
            direction: 'outbound',
          },
        })
      } catch {
        // Non-critical
      }
    })

    // Track timeouts
    req.on('timeout', () => {
      span.addEvent('request.timeout')
      span.setStatus('error', 'Request timed out')
    })

    return req
  }
}

// ─── URL Parsing ────────────────────────────────────────────────────────────

interface UrlInfo {
  method: string
  hostname: string
  path: string
  fullUrl: string
}

function extractUrlInfo(args: unknown[], scheme: string): UrlInfo {
  let method = 'GET'
  let hostname = 'unknown'
  let path = '/'
  let fullUrl = ''

  try {
    const first = args[0]

    if (typeof first === 'string') {
      const url = new URL(first)
      hostname = url.hostname
      path = url.pathname + url.search
      fullUrl = first
    } else if (first instanceof URL) {
      hostname = first.hostname
      path = first.pathname + first.search
      fullUrl = first.toString()
    } else if (first && typeof first === 'object') {
      const opts = first as http.RequestOptions
      hostname = String(opts.hostname ?? opts.host ?? 'unknown')
      path = String(opts.path ?? '/')
      method = String(opts.method ?? 'GET').toUpperCase()
      const port = opts.port ? `:${opts.port}` : ''
      fullUrl = `${scheme}://${hostname}${port}${path}`
    }

    // Check for method in second argument (options object)
    const second = args[1]
    if (second && typeof second === 'object' && 'method' in second) {
      method = String((second as { method: string }).method).toUpperCase()
    }
  } catch {
    // URL parsing failure — use defaults
  }

  return { method, hostname, path, fullUrl }
}

/**
 * Check if a URL is the SDK's own ingestion endpoint — used to skip
 * self-instrumentation and prevent recursive infinite spans.
 */
function isSdkInternalRequest(url: string): boolean {
  try {
    if (!client.initialized) return false
    const ingestUrl = client.config.ingestUrl
    if (!ingestUrl) return false
    // Compare origin + pathname to avoid false negatives from query params
    const target = new URL(url)
    const ingest = new URL(ingestUrl)
    return target.origin === ingest.origin && target.pathname === ingest.pathname
  } catch {
    return false
  }
}

/**
 * Reset instrumentation state — for testing.
 * @internal
 */
export function resetHttpInstrumentation(): void {
  instrumented = false
}
