/**
 * Fastify Framework Instrumentation — automatic request tracing and telemetry.
 *
 * Provides a Fastify plugin that:
 * - Creates per-request async context with trace/span IDs
 * - Automatically captures request events (method, URL, status, latency)
 * - Adds HTTP breadcrumbs
 * - Injects trace context into response headers for downstream consumers
 * - Extracts incoming trace context from request headers (W3C propagation)
 *
 * Usage:
 *   import Fastify from 'fastify'
 *   import { fastifyPulsePlugin } from '@vikasbaplawat1/pulse-sdk'
 *
 *   const app = Fastify()
 *   app.register(fastifyPulsePlugin)
 */

import { withContext, createContextStore, addBreadcrumb } from '../core/context.js'
import { captureRequest } from '../capture/captureRequest.js'
import { extractTraceContext, injectTraceContext } from '../tracing/context-propagation.js'
import { startSpan } from '../tracing/tracer.js'
import { getLogger } from '../utils/logger.js'
import { generateId } from '../utils/uuid.js'
import type { SeverityLevel } from '../types/severity.js'

export interface PulseFastifyOptions {
  /** Paths to ignore from instrumentation (e.g., '/health', '/ready'). */
  ignorePaths?: string[]
  /** Whether to capture request headers. Default: true. */
  captureHeaders?: boolean
  /** Whether to capture query parameters. Default: true. */
  captureQuery?: boolean
  /** Max breadcrumbs per request context. Default: 100. */
  maxBreadcrumbs?: number
}

// Use generic types to avoid requiring @types/fastify as a dependency.
// Consumers who register this plugin already have Fastify typed.
type FastifyInstance = {
  addHook(name: string, handler: (...args: unknown[]) => void): void
}
type FastifyRequest = {
  method: string
  url: string
  hostname: string
  headers: Record<string, string | string[] | undefined>
  query: unknown
}
type FastifyReply = {
  statusCode: number
  header(key: string, value: string): void
}

/**
 * Fastify plugin for Pulse SDK instrumentation.
 * Register with `app.register(fastifyPulsePlugin)`.
 */
export function fastifyPulsePlugin(
  fastify: FastifyInstance,
  opts: PulseFastifyOptions,
  done: (err?: Error) => void
): void {
  const logger = getLogger()
  const ignorePaths = new Set(opts.ignorePaths ?? ['/health', '/ready', '/healthz', '/livez'])
  const captureHeaders = opts.captureHeaders ?? true
  const captureQuery = opts.captureQuery ?? true
  const maxBreadcrumbs = opts.maxBreadcrumbs ?? 100

  fastify.addHook('onRequest', (request: unknown, _reply: unknown, hookDone: unknown) => {
    const req = request as FastifyRequest
    const next = hookDone as (err?: Error) => void

    // Skip ignored paths
    const path = req.url.split('?')[0] ?? ''
    if (ignorePaths.has(path)) {
      next()
      return
    }

    // Extract incoming trace context from headers
    extractTraceContext(req.headers)

    // Start a server span for this request
    const span = startSpan(`${req.method} ${req.url}`, {
      attributes: {
        'http.method': req.method,
        'http.url': req.url,
        'http.host': req.hostname,
        'http.user_agent': String(req.headers['user-agent'] ?? 'unknown'),
        'span.kind': 'SERVER',
      },
    })

    // Create SDK context store
    const store = createContextStore(
      (req.headers['x-request-id'] as string) ?? generateId(),
      maxBreadcrumbs,
      {
        traceId: span.traceId,
        spanId: span.spanId,
        userId: (req.headers['x-user-id'] as string) ?? undefined,
      }
    )

    // Stash span and metadata on request for later hooks
    const reqRecord = req as unknown as Record<string, unknown>
    reqRecord.__pulseSpan = span
    reqRecord.__pulseStore = store
    reqRecord.__pulseStartTime = Date.now()

    next()
  })

  fastify.addHook('onResponse', (request: unknown, reply: unknown, hookDone: unknown) => {
    const req = request as FastifyRequest
    const rep = reply as FastifyReply
    const next = hookDone as (err?: Error) => void

    const path = req.url.split('?')[0] ?? ''
    if (ignorePaths.has(path)) {
      next()
      return
    }

    const reqRecord = req as unknown as Record<string, unknown>
    const span = reqRecord.__pulseSpan as ReturnType<typeof startSpan> | undefined
    const startTime = reqRecord.__pulseStartTime as number | undefined
    const latency = startTime ? Date.now() - startTime : 0
    const statusCode = rep.statusCode

    // End the span
    if (span) {
      span.setAttribute('http.status_code', statusCode)
      span.setStatus(statusCode >= 400 ? 'error' : 'ok')
      span.end()
    }

    // Inject trace context into response headers
    const responseHeaders: Record<string, string> = {}
    injectTraceContext(responseHeaders)
    for (const [key, value] of Object.entries(responseHeaders)) {
      rep.header(key, value)
    }

    // Capture the request event
    try {
      captureRequest({
        type: 'request',
        requestId: (req.headers['x-request-id'] as string) ?? generateId(),
        url: req.url,
        method: req.method,
        statusCode,
        latency,
        timestamp: Date.now(),
        headers: captureHeaders ? sanitizeHeaders(req.headers as Record<string, unknown>) : undefined,
        query: captureQuery ? (req.query as Record<string, unknown>) : undefined,
      })
    } catch (err) {
      logger.error('captureRequest failed in Fastify plugin', { error: err })
    }

    // Add breadcrumb
    try {
      const level: SeverityLevel = statusCode >= 500 ? 'error' : statusCode >= 400 ? 'warning' : 'info'
      addBreadcrumb({
        category: 'http',
        message: `${req.method} ${req.url} [${statusCode}] ${latency}ms`,
        level,
        type: 'http',
        data: {
          method: req.method,
          url: req.url,
          statusCode,
          duration: latency,
          direction: 'inbound',
        },
      })
    } catch {
      // Non-critical
    }

    next()
  })

  logger.info('Fastify Pulse SDK plugin registered', {
    ignorePaths: [...ignorePaths],
  })

  done()
}

// ─── Utilities ──────────────────────────────────────────────────────────────

const SENSITIVE_HEADERS = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
  'proxy-authorization',
])

function sanitizeHeaders(headers: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(headers)) {
    if (SENSITIVE_HEADERS.has(key.toLowerCase())) {
      sanitized[key] = '[REDACTED]'
    } else {
      sanitized[key] = value
    }
  }
  return sanitized
}
