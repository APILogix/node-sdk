/**
 * Express request-capture middleware.
 *
 * Enterprise-grade integration points:
 *   - KillswitchEngine: short-circuits when SDK or tracing is disabled.
 *   - FeatureController: respects the remote `tracing` feature flag.
 *   - TenantGovernor: per-tenant admission control before any work.
 *   - SecurityScrubber: shared scrubbing for headers / query / body.
 *   - ConfigManager: honours `tracing.ignoredRoutes`, `tracing.ignoredMethods`,
 *     and `tracing.capture.*` so a single remote-config flip changes capture
 *     behaviour at runtime — no redeploy.
 *
 * Span ownership model:
 *   When OpenTelemetry's `HttpInstrumentation` is enabled (the default,
 *   registered by `registerAutoInstrumentations`), it creates a SERVER
 *   span automatically for every incoming request. This middleware does
 *   NOT create its own root span in that case — it enriches the OTel span
 *   with Pulse-specific attributes (request id, tenant id, user id, route,
 *   latency) when the response is finished.
 *
 *   When HTTP auto-instrumentation is disabled (deployment opt-out, or the
 *   middleware is exercised in isolation by tests), we create our own
 *   SERVER root span so the request is still fully captured. This keeps
 *   the "exactly one root span per request" invariant regardless of the
 *   OTel topology.
 *
 *   In both cases the AsyncLocalStorage `ContextStore` (request id,
 *   breadcrumbs, user/tenant) is established for the entire request
 *   lifetime via `withContext`, so any descendant code — including all
 *   OTel auto-instrumented child spans (DB, Redis, outbound HTTP) — sees
 *   the same trace context.
 *
 * The middleware is intentionally fail-open: any unexpected error inside
 * the instrumentation path must NEVER take down the host application.
 * Every branch that can throw is wrapped in a defensive try/catch.
 */

import type { NextFunction, Request, Response } from 'express'
import { captureError } from '../capture/captureError.js'
import { trace, SpanKind, type Span } from '@opentelemetry/api'
import { client } from '../core/client.js'
import {
  attachRequestContextToActiveSpan,
  createContextStore,
  withContext,
} from '../core/context.js'
import { getLogger } from '../utils/logger.js'
import { generateId } from '../utils/uuid.js'
import { getTracer } from '../tracing/tracer.js'
import {
  captureBodySnapshot,
  evaluateCaptureGate,
  headerString,
  matchesIgnoredPath,
  recordCaptureAccepted,
  resolveClientIp,
  scrubHeaders,
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
  /**
   * Force-capture request headers regardless of remote config. When
   * undefined (default), the remote `tracing.capture.headers` flag wins.
   */
  readonly captureHeaders?: boolean
  /** Force-capture query string regardless of remote config. */
  readonly captureQuery?: boolean
  /**
   * Force-capture request body. Only applies when the body is a parsed JSON
   * object (e.g. `express.json()` middleware ran first). Strings and Buffers
   * report size only. Default: governed by remote config.
   */
  readonly captureBody?: boolean
  /** Maximum number of breadcrumbs retained on the request scope. */
  readonly maxBreadcrumbs?: number
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
    const requestId = headerString(req.headers['x-request-id'])
      ?? headerString(req.headers['x-correlation-id'])
      ?? generateId()
    // Tenant id is needed by the gate; resolve it first so admission control
    // can reject before any allocation.
    const tenantId = headerString(req.headers['x-tenant-id'])

    const decision = evaluateCaptureGate({
      path,
      method: req.method,
      sampleKey: requestId,
      tenantId,
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
    const sessionId = headerString(req.headers['x-session-id'])
    const userAgent = headerString(req.headers['user-agent'])
    const referer = headerString(req.headers['referer'] ?? req.headers['referrer'])
    const clientIp = resolveClientIp(req.headers, req.socket?.remoteAddress)
    const startTime = Date.now()

    const store = createContextStore(
      requestId,
      options.maxBreadcrumbs ?? client.config?.maxBreadcrumbs ?? 100,
      {
        userId,
        sessionId,
        extra: tenantId ? { tenantId } : undefined,
        tags: { framework: 'express' },
      },
    )

    // Local override resolution. `undefined` means "follow remote config".
    const captureHeaders = options.captureHeaders ?? decision.allowHeaders
    const captureQuery = options.captureQuery ?? decision.allowQuery
    const captureBody = options.captureBody ?? decision.allowBody

    withContext(store, () => {
      // Ownership of the SERVER root span:
      //   1. If OTel HttpInstrumentation is enabled, it has already created
      //      a SERVER span as the active span before this middleware runs.
      //      We just enrich it with Pulse attributes on response.
      //   2. If HttpInstrumentation is disabled, no SERVER span exists. We
      //      create one ourselves so this request is still represented in
      //      the trace tree as a root span. We own its lifecycle (end on
      //      response finish/close/error) and its parent context (it has
      //      none — it's a root).
      //
      // Either way the active span at this point is the SERVER root, so
      // attaching context attributes here populates the root span (where
      // backends normally render the request name and URL).
      let ownedSpan: Span | undefined
      const existingActive = trace.getActiveSpan()
      if (!existingActive) {
        const tracer = getTracer()
        if (tracer) {
          ownedSpan = tracer.startSpan(`${req.method} ${path}`, {
            kind: SpanKind.SERVER,
            attributes: {
              'http.method': req.method,
              'http.target': path,
              'http.scheme': req.protocol,
              'http.host': req.headers.host,
              'pulse.request_id': requestId,
              'pulse.framework': 'express',
              'pulse.fallback_root': true,
            },
          })
        }
      }

      attachRequestContextToActiveSpan(store)

      let captured = false
      const captureCompletion = (): void => {
        if (captured) return
        captured = true

        // Re-enter the request's ALS scope so descendants — particularly
        // any captureError() the user calls in onResponse hooks — see the
        // request's ContextStore. The OTel context is preserved by the
        // EventEmitter binding patch, but ALS is a separate channel and
        // must be re-installed explicitly here.
        withContext(store, () => {
          try {
            const bodySnapshot = captureBodySnapshot((req as Request & { body?: unknown }).body, captureBody)
            const responseSize = readContentLength(res.getHeader('content-length'))

            recordCaptureAccepted(tenantId)

            // Enrich whichever span owns this request — the OTel-created one
            // or our owned fallback. We must re-resolve the active span here
            // because by the time `finish` fires, the ALS chain is the one
            // that flowed through user code, not the original middleware
            // call frame. `trace.getActiveSpan()` reads from the OTel context
            // bound to this listener (preserved by `EventEmitter` binding).
            const activeSpan = ownedSpan ?? trace.getActiveSpan()
            if (activeSpan) {
              const route = normalizedRoute(req)
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
              activeSpan.setAttributes(enrichmentAttrs)
            }
          } catch (err) {
            // The middleware must NEVER crash the host. Log and move on.
            getLogger().error('monitorMiddleware completion failed', { error: err })
          } finally {
            // Always end the owned fallback span — even if enrichment threw,
            // we must not leak the span. Idempotency is safe: OTel's Span
            // implementation guards against double-end internally.
            if (ownedSpan) {
              try { ownedSpan.end() } catch { /* never throw from response handler */ }
            }
          }
        })
      }

      res.once('finish', captureCompletion)
      res.once('close', captureCompletion)
      res.once('error', error => {
        // Re-enter ALS so captureError can pick up the request context
        // (requestId, breadcrumbs, tenantId). Without this withContext
        // wrapper, getRequestContext() inside captureError returns
        // undefined and the error event is emitted without enrichment.
        withContext(store, () => {
          try {
            captureError(error, {
              context: {
                requestId,
                route: normalizedRoute(req),
                framework: 'express',
                ...(tenantId ? { tenantId } : {}),
              },
            })
            if (ownedSpan) {
              try { ownedSpan.recordException(error) } catch { /* fail-open */ }
            }
          } catch (err) {
            getLogger().error('monitorMiddleware error capture failed', { error: err })
          }
        })
      })

      next()
    })
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
