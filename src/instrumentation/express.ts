/**
 * Express request-capture middleware.
 *
 * Enterprise-grade integration points:
 *   - KillswitchEngine: short-circuits when SDK or tracing is disabled.
 *   - FeatureController: respects the remote `tracing` feature flag.
 *   - TenantGovernor: atomic per-tenant admission in the canonical pipeline.
 *   - SecurityScrubber: shared scrubbing for headers / query / body.
 *   - ConfigManager: uses the active backend privacy and sampling policy;
 *     middleware ignore lists remain local integration filters only.
 *
 * Span ownership model:
 *   OpenTelemetry HttpInstrumentation owns SERVER span creation when enabled
 *   by remote configuration. This middleware enriches an active span but
 *   never creates a fallback span when HTTP instrumentation is disabled.
 *   It always emits the discrete request event when request capture passes.
 *
 * The AsyncLocalStorage `ContextStore` (request id, breadcrumbs, user/tenant)
 * is established for the request lifetime so descendant work sees consistent
 * SDK context.
 *
 * The middleware is intentionally fail-open: any unexpected error inside
 * the instrumentation path must NEVER take down the host application.
 * Every branch that can throw is wrapped in a defensive try/catch.
 */

import type { NextFunction, Request, Response } from 'express'
import { captureError } from '../capture/captureError.js'
import { captureRequest } from '../capture/captureRequest.js'
import { trace, context, SpanKind, SpanStatusCode } from '@opentelemetry/api'
import { client } from '../core/client.js'
import {
  attachRequestContextToActiveSpan,
  createContextStore,
  withContext,
  getRequestContext,
  getTraceId,
  getSpanId,
} from '../core/context.js'
import { FeatureController } from '../core/feature-controller.js'
import { KillswitchEngine } from '../core/killswitch-engine.js'
import { ConfigManager } from '../core/config-manager.js'
import { SDK_NAME, SDK_VERSION } from '../constants/version.js'
import { getLogger } from '../utils/logger.js'
import { generateId } from '../utils/uuid.js'
import { extractTraceContext } from '../tracing/context-propagation.js'
import { getTraceAggregator } from '../tracing/trace-aggregator.js'
import {
  captureBodySnapshot,
  evaluateCaptureGate,
  headerString,
  matchesIgnoredPath,
  resolveClientIp,
  scrubHeaders,
  scrubQuery,
} from './request-capture-utils.js'

export interface PulseExpressOptions {
  /**
   * Paths that should never be captured. Matching is prefix-based for strings
   * and full regex for `RegExp`. Evaluated before any remote-config rules,
   * so this is the cheapest place to silence noisy paths (e.g. `/healthz`).
   */
  readonly ignorePaths?: readonly (string | RegExp)[]
  /** HTTP methods to skip (case-insensitive). Useful for `OPTIONS`/`HEAD`. */
  readonly ignoreMethods?: readonly string[]
  /** Maximum number of breadcrumbs retained on the request scope. */
  readonly maxBreadcrumbs?: number
  /**
   * IPs of trusted reverse proxies (exact match, or `*` to trust any peer —
   * only safe when the app is unreachable except via a proxy). When the
   * immediate peer is trusted, `X-Forwarded-For` / `X-Real-IP` are used to
   * resolve the client IP; otherwise those headers are ignored because any
   * client can spoof them. Default: no trusted proxies (socket IP wins).
   */
  readonly trustedProxies?: readonly string[]
}

export function monitorMiddleware(options: PulseExpressOptions = {}) {
  return function pulseExpressMiddleware(req: Request, res: Response, next: NextFunction): void {
    // Resolve the path *once*, defensively. Express attaches `path` only after
    // routing, so callers placing the middleware before any routes still get
    // a usable value via originalUrl/url.
    const path = ((req.path || req.originalUrl || req.url || '/').split('?')[0]) || '/'

    // Cheap framework-level ignore — short-circuits before we touch any
    // SDK engines so misconfigured users still pay near-zero overhead.
    if (matchesIgnoredPath(path, options.ignorePaths)) {
      next()
      return
    }

    // Resolve request identity *before* the gate so the sampling engine
    // can use a stable id to make a deterministic decision.
    const headers = (req.headers as Record<string, string | string[] | undefined>) || {}
    const requestId = headerString(headers['x-request-id'])
      ?? headerString(headers['x-correlation-id'])
      ?? generateId()
    // Tenant id is needed by the gate; resolve it first so admission control
    // can reject before any allocation.
    const tenantId = headerString(headers['x-tenant-id'])

    const decision = evaluateCaptureGate({
      path,
      method: req.method,
      sampleKey: requestId,
      localIgnorePaths: options.ignorePaths,
      localIgnoreMethods: options.ignoreMethods,
    })

    if (!decision.capture) {
      next()
      return
    }

    // Resolve the rest of the request identity. These values are cheap so
    // we resolve them after the gate to avoid wasting work on dropped
    // requests.
    const userId = readUserId(req)
    const sessionId = headerString(headers['x-session-id'])
    const userAgent = headerString(headers['user-agent'])
    const referer = headerString(headers['referer'] ?? headers['referrer'])
    const clientIp = resolveClientIp(headers, req.socket?.remoteAddress, options.trustedProxies, decision.maskIp)
    const startTime = Date.now()

    const extra: Record<string, unknown> = tenantId ? { tenantId } : {}
    Object.defineProperties(extra, {
      getStatusCode: { value: () => res.statusCode, enumerable: false, configurable: true, writable: true },
      getMethod: { value: () => req.method, enumerable: false, configurable: true, writable: true },
      getUrl: { value: () => req.originalUrl || req.url, enumerable: false, configurable: true, writable: true },
      getRoute: { value: () => normalizedRoute(req), enumerable: false, configurable: true, writable: true },
    })

    const store = createContextStore(
      requestId,
      options.maxBreadcrumbs ?? 100,
      {
        userId,
        sessionId,
        extra,
        tags: { framework: 'express' },
      },
    )

    // Privacy capture policy is backend-authoritative.
    const captureHeaders = decision.allowHeaders
    const captureQuery = decision.allowQuery
    const captureBody = decision.allowBody

    const configManager = ConfigManager.getInstance()
    const httpInstrumentationEnabled = Boolean(configManager.getConfig().instrumentation.http)
    let activeSpan = trace.getActiveSpan() ?? (req as any)?.__pulseServerSpan
    let createdServerSpan = false

    const featureCtrl = FeatureController.getInstance()
    const killswitchEngine = KillswitchEngine.getInstance()
    const isTracingActive = !killswitchEngine?.isKilled('disableTracing') && (!featureCtrl || featureCtrl.isEnabled('tracing'))

    const parentContext = extractTraceContext(headers)

    // Create server span if no active span exists (e.g. direct middleware invocation, synthetic tests, or custom server)
    if (!activeSpan && isTracingActive) {
      try {
        const tracer = trace.getTracer(SDK_NAME, SDK_VERSION)
        activeSpan = tracer.startSpan(
          `HTTP ${req.method} ${path}`,
          {
            kind: SpanKind.SERVER,
            attributes: {
              'http.method': req.method,
              'http.url': req.originalUrl || req.url,
              'http.route': path,
              'http.target': req.url,
              ...(req.headers.host ? { 'http.host': req.headers.host } : {}),
              ...(headers['host'] ? { 'http.host': String(headers['host']) } : {}),
              ...(userAgent ? { 'http.user_agent': userAgent } : {}),
              ...(clientIp ? { 'http.client_ip': clientIp } : {}),
            },
          },
          parentContext ?? context.active(),
        )
        createdServerSpan = true
      } catch {
        // Fail-open: tracing creation failure should never affect request processing
      }
    }

    const runInScope = () => {
      withContext(store, () => {
        attachRequestContextToActiveSpan(store)

        let captured = false
        const captureCompletion = (): void => {
          if (captured) return
          captured = true

          withContext(store, () => {
            try {
              const bodySnapshot = captureBodySnapshot((req as Request & { body?: unknown }).body, captureBody)
              const responseSize = readContentLength(res.getHeader('content-length'))

              const currentActiveSpan = trace.getActiveSpan() ?? activeSpan
              if (currentActiveSpan) {
                const route = normalizedRoute(req)
                if (typeof (currentActiveSpan as any).updateName === 'function') {
                  ;(currentActiveSpan as any).updateName(`HTTP ${req.method} ${route}`)
                }
                const enrichmentAttrs: Record<string, string | number | boolean> = {
                  'http.route': route,
                  'http.status_code': res.statusCode,
                  'pulse.request_id': requestId,
                  'pulse.latency_ms': Date.now() - startTime,
                }
                if (tenantId) enrichmentAttrs['pulse.tenant_id'] = tenantId
                if (userId) enrichmentAttrs['pulse.user_id'] = userId
                if (sessionId) enrichmentAttrs['pulse.session_id'] = sessionId
                if (clientIp) enrichmentAttrs['http.client_ip'] = clientIp
                if (userAgent) enrichmentAttrs['http.user_agent'] = userAgent
                if (referer) enrichmentAttrs['http.referer'] = referer
                if (bodySnapshot.bodySize !== undefined) enrichmentAttrs['http.request.body.size'] = bodySnapshot.bodySize
                if (responseSize !== undefined) enrichmentAttrs['http.response.body.size'] = responseSize
                currentActiveSpan.setAttributes(enrichmentAttrs)

                if (res.statusCode >= 500) {
                  currentActiveSpan.setStatus({ code: SpanStatusCode.ERROR })
                } else if (res.statusCode >= 100 && res.statusCode < 400) {
                  currentActiveSpan.setStatus({ code: SpanStatusCode.OK })
                }
              }

              if (createdServerSpan && activeSpan) {
                const serverSpan = activeSpan
                const traceId = serverSpan.spanContext().traceId
                let ended = false
                const endServerSpan = () => {
                  if (ended) return
                  ended = true
                  try {
                    serverSpan.end()
                  } catch (endErr) {
                    getLogger().error('Failed to end server span', { error: endErr })
                  }
                }
                const aggregator = getTraceAggregator()
                if (aggregator.getActiveSpanCount(traceId) > 1) {
                  aggregator.waitForActiveChildren(traceId, endServerSpan, 10000)
                } else {
                  endServerSpan()
                }
              }

              // Emit the discrete request event to the canonical requests route.
              captureRequest({
                type: 'request',
                requestId,
                method: req.method,
                url: normalizedRoute(req),
                statusCode: res.statusCode,
                latency: Date.now() - startTime,
                timestamp: startTime,
                traceId: getTraceId() ?? store.traceId ?? activeSpan?.spanContext().traceId,
                spanId: getSpanId() ?? store.spanId ?? activeSpan?.spanContext().spanId,
                ...(userId ? { userId } : {}),
                ...(tenantId ? { tenantId } : {}),
                ...(sessionId ? { sessionId } : {}),
                ...(clientIp ? { clientIp } : {}),
                ...(userAgent ? { userAgent } : {}),
                ...(referer ? { referer } : {}),
                ...(captureHeaders ? { headers: scrubHeadersSafe(req.headers) } : {}),
                ...(captureHeaders ? { headers: scrubHeadersSafe(headers) } : {}),
                ...(captureQuery && isRecord(req.query) ? { query: scrubQuery(req.query) } : {}),
                ...(bodySnapshot.body ? { body: bodySnapshot.body } : {}),
                ...(bodySnapshot.bodySize !== undefined ? { bodySize: bodySnapshot.bodySize } : {}),
                ...(responseSize !== undefined ? { responseSize } : {}),
                route: normalizedRoute(req),
              })
            } catch (err) {
              getLogger().error('monitorMiddleware completion failed', { error: err })
            }
          })
        }

        res.once('finish', captureCompletion)
        res.once('close', captureCompletion)
        res.once('error', error => {
          withContext(store, () => {
            try {
              if (store.extra) {
                ;(store.extra as Record<string, unknown>).mechanism = 'express.res.error'
                ;(store.extra as Record<string, unknown>).handled = true
              }
              captureError(error)
              const currentActiveSpan = trace.getActiveSpan() ?? activeSpan
              if (currentActiveSpan) {
                try {
                  currentActiveSpan.recordException(error)
                  currentActiveSpan.setStatus({ code: SpanStatusCode.ERROR, message: error.message })
                } catch { /* fail-open */ }
              }
            } catch (err) {
              getLogger().error('monitorMiddleware error capture failed', { error: err })
            }
          })
        })

        const wrappedNext: NextFunction = (err?: unknown): void => {
          if (err) {
            const error = err instanceof Error ? err : new Error(String(err))
            withContext(store, () => {
              try {
                if (store.extra) {
                  ;(store.extra as Record<string, unknown>).mechanism = 'express.next'
                  ;(store.extra as Record<string, unknown>).handled = true
                }
                captureError(error)
                const currentActiveSpan = trace.getActiveSpan() ?? activeSpan
                if (currentActiveSpan) {
                  try {
                    currentActiveSpan.recordException(error)
                    currentActiveSpan.setStatus({ code: SpanStatusCode.ERROR, message: error.message })
                  } catch { /* fail-open */ }
                }
              } catch (captureErr) {
                getLogger().error('monitorMiddleware next(err) capture failed', { error: captureErr })
              }
            })
          }
          next(err as Error | undefined)
        }

        wrappedNext()
      })
    }

    if (activeSpan) {
      context.with(trace.setSpan(parentContext ?? context.active(), activeSpan), runInScope)
    } else {
      runInScope()
    }
  }
}

/**
 * Express error-handling middleware. Place after all routes and before custom error responses.
 * Automatically captures any error passed to next(err) or thrown in route handlers.
 *
 * @example
 * ```ts
 * app.use(monitorMiddleware())
 * // ... routes ...
 * app.use(expressErrorHandler())
 * ```
 */
export function expressErrorHandler() {
  return function pulseExpressErrorHandler(err: unknown, req: Request, res: Response, next: NextFunction): void {
    if (err) {
      try {
        const store = getRequestContext()
        if (store && store.extra) {
          ;(store.extra as Record<string, unknown>).mechanism = 'express.next'
          ;(store.extra as Record<string, unknown>).handled = true
        }
        const error = err instanceof Error ? err : new Error(String(err))
        captureError(error)
        const activeSpan = trace.getActiveSpan()
        if (activeSpan) {
          try {
            activeSpan.recordException(error)
            activeSpan.setStatus({ code: SpanStatusCode.ERROR, message: error.message })
          } catch { /* fail-open */ }
        }
      } catch {
        // Error capture must remain fail-open
      }
    }
    next(err as Error | undefined)
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function normalizedRoute(req: Request): string {
  const routePath = routePathToString(req.route?.path)
  if (routePath) {
    const base = req.baseUrl && req.baseUrl !== '/' ? req.baseUrl : ''
    return `${base}${routePath}`
  }

  return (req.path || req.originalUrl || req.url || '').split('?')[0] || '/'
}

function routePathToString(path: unknown): string | undefined {
  if (typeof path === 'string') return path
  if (path instanceof RegExp) return path.source
  return undefined
}

function readUserId(req: Request): string | undefined {
  const user = (req as Request & { user?: { id?: unknown; userId?: unknown } }).user
  const value = user?.id ?? user?.userId
  return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined
}

function readContentLength(value: number | string | string[] | undefined): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  if (Array.isArray(value) && value.length > 0) {
    const parsed = Number.parseInt(String(value[0]), 10)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

function scrubHeadersSafe(headers?: Request['headers'] | Record<string, unknown>): Record<string, unknown> {
  if (!headers || typeof headers !== 'object') return {}
  try {
    const clone: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(headers)) clone[key] = value
    return scrubHeaders(clone) ?? {}
  } catch {
    return {}
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
