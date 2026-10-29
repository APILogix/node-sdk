/**
 * Fastify request-capture plugin.
 *
 * Mirrors the enterprise hardening of `pulseMiddleware` for Express:
 *   - Killswitch + FeatureController gates
 *   - Tenant admission control
 *   - Centralized scrubbing via SecurityScrubber
 *   - Backend-authoritative sampling and privacy capture policy
 *
 * The plugin is intentionally fail-open. If any hook throws, the host
 * application continues serving traffic and the SDK logs the failure.
 */

import { captureException } from '../capture/captureException.js'
import { captureRequest } from '../capture/captureRequest.js'
import { trace, context, SpanKind, SpanStatusCode, type Span } from '@opentelemetry/api'
import { client } from '../core/client.js'
import {
  attachRequestContextToActiveSpan,
  createContextStore,
  getSpanId,
  getTraceId,
  type ContextStore,
  withContext,
} from '../core/context.js'
import { FeatureController } from '../core/feature-controller.js'
import { KillswitchEngine } from '../core/killswitch-engine.js'
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

export interface LynkTraceFastifyOptions {
  readonly ignorePaths?: readonly (string | RegExp)[]
  readonly ignoreMethods?: readonly string[]
  readonly maxBreadcrumbs?: number
  /**
   * IPs of trusted reverse proxies (exact match, or `*` to trust any peer).
   * Forwarded headers (`X-Forwarded-For` / `X-Real-IP`) are only honored
   * when the immediate peer is trusted; otherwise the socket IP wins.
   * Note: `request.ip` already respects Fastify's own `trustProxy` setting
   * and takes precedence when available.
   */
  readonly trustedProxies?: readonly string[]
  /** Capture schema validation responses (HTTP 422). Other 4xx responses are ignored. Default: false. */
  readonly captureValidationErrors?: boolean
}

type FastifyInstance = {
  addHook(name: 'onRequest', handler: (request: FastifyRequest, reply: FastifyReply, done: HookDone) => void): void
  addHook(name: 'preHandler', handler: (request: FastifyRequest, reply: FastifyReply, done: HookDone) => void): void
  addHook(name: 'onResponse', handler: (request: FastifyRequest, reply: FastifyReply, done: HookDone) => void): void
  addHook(name: 'onError', handler: (request: FastifyRequest, reply: FastifyReply, error: Error, done: HookDone) => void): void
  addHook(name: 'preSerialization', handler: (request: FastifyRequest, reply: FastifyReply, payload: unknown, done: (err: Error | null, payload?: unknown) => void) => void): void
  addHook(name: 'onSend', handler: (request: FastifyRequest, reply: FastifyReply, payload: unknown, done: (err: Error | null, payload?: unknown) => void) => void): void
}

type HookDone = (err?: Error) => void

type FastifyRequest = {
  id?: string
  method: string
  url: string
  headers: Record<string, string | string[] | undefined>
  query?: unknown
  body?: unknown
  ip?: string
  socket?: { remoteAddress?: string }
  routeOptions?: { url?: string }
  routerPath?: string
  user?: { id?: unknown; userId?: unknown }
  lynktrace?: LynkTraceFastifyState
  pulse?: LynkTraceFastifyState
}

type FastifyReply = {
  statusCode?: number
  raw?: { statusCode?: number }
  getHeader?: (name: string) => string | string[] | number | undefined
}

export interface LynkTraceFastifyState {
  requestId: string
  store: ContextStore
  startTime: number
  captured: boolean
  activeSpan?: Span | undefined
  createdServerSpan?: boolean | undefined
  tenantId: string | undefined
  userId: string | undefined
  sessionId: string | undefined
  clientIp: string | undefined
  userAgent: string | undefined
  referer: string | undefined
  captureHeaders: boolean
  captureQuery: boolean
  captureBody: boolean
}

export function lynktraceFastifyPlugin(
  fastify: FastifyInstance,
  opts: LynkTraceFastifyOptions,
  done: (err?: Error) => void,
): void {
  const options = opts ?? {}

  fastify.addHook('onRequest', (request, _reply, hookDone) => {
    try {
      const path = request.url.split('?')[0] || '/'

      if (matchesIgnoredPath(path, options.ignorePaths)) {
        hookDone()
        return
      }

      // Resolve identity up front so the sampling decision is deterministic.
      const headers = (request.headers as Record<string, string | string[] | undefined>) || {}
      const requestId = headerString(headers['x-request-id'])
        ?? headerString(headers['x-correlation-id'])
        ?? request.id
        ?? generateId()
      const tenantId = headerString(headers['x-tenant-id'])

      const decision = evaluateCaptureGate({
        path,
        method: request.method,
        sampleKey: requestId,
        localIgnorePaths: options.ignorePaths,
        localIgnoreMethods: options.ignoreMethods,
      })

      if (!decision.capture) {
        hookDone()
        return
      }

      const userId = extractUserId(request)
      const sessionId = headerString(headers['x-session-id'])
      const userAgent = headerString(headers['user-agent'])
      const referer = headerString(headers['referer'] ?? headers['referrer'])
      const clientIp = resolveClientIp(headers, request.socket?.remoteAddress, options.trustedProxies, decision.maskIp, request.ip)

      const extra: Record<string, unknown> = tenantId ? { tenantId } : {}
      Object.defineProperties(extra, {
        getStatusCode: { value: () => (request as any).raw?.statusCode ?? (request as any).reply?.statusCode, enumerable: false, configurable: true, writable: true },
        getMethod: { value: () => request.method, enumerable: false, configurable: true, writable: true },
        getUrl: { value: () => request.url, enumerable: false, configurable: true, writable: true },
        getRoute: { value: () => normalizeRoute(request), enumerable: false, configurable: true, writable: true },
      })

      const store = createContextStore(
        requestId,
        options.maxBreadcrumbs ?? 100,
        {
          userId,
          sessionId,
          extra,
          tags: { framework: 'fastify' },
        },
      )

      const tracer = trace.getTracer(SDK_NAME, SDK_VERSION)
      let activeSpan = trace.getActiveSpan()
      let createdServerSpan = false

      const featureCtrl = FeatureController.getInstance()
      const killswitchEngine = KillswitchEngine.getInstance()
      const isTracingActive = !killswitchEngine?.isKilled('disableTracing') && (!featureCtrl || featureCtrl.isEnabled('tracing'))

      const parentContext = extractTraceContext(headers)

      if (!activeSpan && isTracingActive) {
        try {
          activeSpan = tracer.startSpan(
            `HTTP ${request.method} ${path}`,
            {
              kind: SpanKind.SERVER,
              attributes: {
                'http.method': request.method,
                'http.url': request.url,
                'http.route': path,
                'http.target': request.url,
                ...(request.headers.host ? { 'http.host': String(request.headers.host) } : {}),
                ...(headers['host'] ? { 'http.host': String(headers['host']) } : {}),
                ...(userAgent ? { 'http.user_agent': userAgent } : {}),
                ...(clientIp ? { 'http.client_ip': clientIp } : {}),
              },
            },
            parentContext ?? context.active(),
          )
          createdServerSpan = true
        } catch {
          // Fail-open
        }
      }

      request.lynktrace = {
        requestId,
        store,
        startTime: Date.now(),
        captured: false,
        activeSpan,
        createdServerSpan,
        tenantId,
        userId,
        sessionId,
        clientIp,
        userAgent,
        referer,
        captureHeaders: decision.allowHeaders,
        captureQuery: decision.allowQuery,
        captureBody: decision.allowBody,
      }
      request.pulse = request.lynktrace

      const runHook = () => {
        withContext(store, () => {
          attachRequestContextToActiveSpan(store)
          hookDone()
        })
      }

      if (createdServerSpan && activeSpan) {
        context.with(trace.setSpan(parentContext ?? context.active(), activeSpan), runHook)
      } else {
        runHook()
      }
    } catch (err) {
      getLogger().error('lynktraceFastifyPlugin onRequest failed', { error: err })
      hookDone()
    }
  })

  fastify.addHook('preHandler', (request, _reply, hookDone) => {
    const state = request.lynktrace ?? request.pulse
    if (!state) {
      hookDone()
      return
    }

    const runInScope = () => {
      withContext(state.store, () => {
        attachRequestContextToActiveSpan(state.store)
        hookDone()
      })
    }

    if (state.createdServerSpan && state.activeSpan) {
      context.with(trace.setSpan(context.active(), state.activeSpan), runInScope)
    } else {
      runInScope()
    }
  })

  fastify.addHook('onResponse', (request, reply, hookDone) => {
    const state = request.lynktrace ?? request.pulse
    if (!state) {
      hookDone()
      return
    }

    withContext(state.store, () => {
      try {
        const statusCode = reply.statusCode ?? reply.raw?.statusCode ?? 0
        if (statusCode >= 500 && !(state.store.extra as Record<string, unknown> | undefined)?.['fastifyErrorCaptured']) {
          const defaultMsg = `Fastify HTTP ${statusCode} error`
          const err = (reply as unknown as { raw?: { _error?: Error } })?.raw?._error
            ?? (request as unknown as { raw?: { _error?: Error } })?.raw?._error
            ?? new Error(defaultMsg)
          if (state.store.extra) {
            ;(state.store.extra as Record<string, unknown>).mechanism = 'fastify.onError'
            ;(state.store.extra as Record<string, unknown>).handled = true
            ;(state.store.extra as Record<string, unknown>).statusCode = statusCode
            ;(state.store.extra as Record<string, unknown>).getStatusCode = () => statusCode
            ;(state.store.extra as Record<string, unknown>).fastifyErrorCaptured = true
          }
          attachRequestContextToActiveSpan(state.store)
          captureException(err)
        }
        captureFastifyCompletion(request, reply, state)
      } catch (err) {
        getLogger().error('lynktraceFastifyPlugin completion failed', { error: err })
      }
      hookDone()
    })
  })

  fastify.addHook('preSerialization', (request, reply, payload, hookDone) => {
    const state = request.lynktrace ?? request.pulse
    if (state) {
      const actualStatusCode = (payload as unknown as { statusCode?: number })?.statusCode
        ?? reply.statusCode
        ?? reply.raw?.statusCode
        ?? 200
      if (shouldCaptureFastifyError(actualStatusCode, payload instanceof Error, options.captureValidationErrors === true)
        && (payload instanceof Error || (payload && typeof payload === 'object' && (payload as Record<string, unknown>).message))) {
        withContext(state.store, () => {
          try {
            if (state.store.extra) {
              ;(state.store.extra as Record<string, unknown>).mechanism = 'fastify.onError'
              ;(state.store.extra as Record<string, unknown>).handled = true
              ;(state.store.extra as Record<string, unknown>).statusCode = actualStatusCode
              ;(state.store.extra as Record<string, unknown>).getStatusCode = () => actualStatusCode
              ;(state.store.extra as Record<string, unknown>).fastifyErrorCaptured = true
            }
            attachRequestContextToActiveSpan(state.store)
            captureException(payload instanceof Error ? payload : new Error(String((payload as Record<string, unknown>).message)))
          } catch (err) {
            getLogger().error('lynktraceFastifyPlugin preSerialization error capture failed', { error: err })
          }
        })
      }
    }
    hookDone(null, payload)
  })

  fastify.addHook('onError', (request, reply, error, hookDone) => {
    const state = request.lynktrace ?? request.pulse
    if (!state) {
      if (typeof hookDone === 'function') hookDone()
      return
    }

    const errStatusCode = (error as unknown as { statusCode?: number; status?: number })?.statusCode
      ?? (error as unknown as { statusCode?: number; status?: number })?.status
      ?? (reply.statusCode && reply.statusCode !== 200 ? reply.statusCode : undefined)
      ?? (reply.raw?.statusCode && reply.raw.statusCode !== 200 ? reply.raw.statusCode : undefined)
      ?? 500

    if (!shouldCaptureFastifyError(errStatusCode, true, options.captureValidationErrors === true)) {
      hookDone()
      return
    }

    withContext(state.store, () => {
      try {
        if (state.store.extra) {
          ;(state.store.extra as Record<string, unknown>).mechanism = 'fastify.onError'
          ;(state.store.extra as Record<string, unknown>).handled = true
          ;(state.store.extra as Record<string, unknown>).statusCode = errStatusCode
          ;(state.store.extra as Record<string, unknown>).getStatusCode = () => errStatusCode
          ;(state.store.extra as Record<string, unknown>).fastifyErrorCaptured = true
        }
        attachRequestContextToActiveSpan(state.store)
        captureException(error)
        const currentActiveSpan = trace.getActiveSpan() ?? state.activeSpan
        if (currentActiveSpan) {
          try {
            currentActiveSpan.recordException(error)
            currentActiveSpan.setStatus({ code: SpanStatusCode.ERROR, message: error.message })
          } catch { /* fail-open */ }
        }
      } catch (err) {
        getLogger().error('lynktraceFastifyPlugin error capture failed', { error: err })
      }
      if (typeof hookDone === 'function') hookDone()
    })
  })

  fastify.addHook('onSend', (request, reply, payload, hookDone) => {
    const state = request.lynktrace ?? request.pulse
    const statusCode = reply.statusCode ?? reply.raw?.statusCode ?? 200

    // BUG-18: Fast-path for non-error responses (< 400).
    // Avoid expensive Buffer stringification and JSON.parse on every 200 OK.
    if (statusCode < 400 && !(payload instanceof Error)) {
      hookDone(null, payload)
      return
    }

    if (state && !(state.store.extra as Record<string, unknown> | undefined)?.['fastifyErrorCaptured']) {
      let errToCapture: Error | null = null
      let effectiveStatusCode = statusCode

      if (payload instanceof Error) {
        errToCapture = payload
        effectiveStatusCode = (payload as unknown as { statusCode?: number }).statusCode ?? effectiveStatusCode
      } else {
        let payloadStr = ''
        if (typeof payload === 'string') {
          payloadStr = payload
        } else if (Buffer.isBuffer(payload)) {
          payloadStr = payload.toString('utf8')
        } else if (payload && typeof payload === 'object') {
          const obj = payload as Record<string, unknown>
          if (typeof obj['statusCode'] === 'number') {
            effectiveStatusCode = obj['statusCode'] as number
          }
          if (typeof obj['message'] === 'string' && effectiveStatusCode >= 400) {
            errToCapture = new Error(String(obj['message']))
          }
        }

        if (payloadStr) {
          try {
            const parsed = JSON.parse(payloadStr) as Record<string, unknown>
            if (parsed && typeof parsed === 'object') {
              if (typeof parsed['statusCode'] === 'number') {
                effectiveStatusCode = parsed['statusCode'] as number
              }
              if (typeof parsed['message'] === 'string' && effectiveStatusCode >= 400) {
                errToCapture = new Error(parsed['message'] as string)
              }
            }
          } catch {}
        }
      }

      if (errToCapture && shouldCaptureFastifyError(
        effectiveStatusCode,
        payload instanceof Error,
        options.captureValidationErrors === true,
      )) {
        withContext(state.store, () => {
          try {
            if (state.store.extra) {
              ;(state.store.extra as Record<string, unknown>).mechanism = 'fastify.onError'
              ;(state.store.extra as Record<string, unknown>).handled = true
              ;(state.store.extra as Record<string, unknown>).statusCode = effectiveStatusCode
              ;(state.store.extra as Record<string, unknown>).getStatusCode = () => effectiveStatusCode
              ;(state.store.extra as Record<string, unknown>).fastifyErrorCaptured = true
            }
            attachRequestContextToActiveSpan(state.store)
            captureException(errToCapture)
          } catch (err) {
            getLogger().error('lynktraceFastifyPlugin onSend error capture failed', { error: err })
          }
        })
      }
    }
    hookDone(null, payload)
  })

  done()
}

function shouldCaptureFastifyError(statusCode: number, isError: boolean, captureValidationErrors: boolean): boolean {
  if (statusCode >= 500) return true
  if (statusCode === 422) return captureValidationErrors
  if (statusCode >= 400) return false
  return isError
}

;(lynktraceFastifyPlugin as any)[Symbol.for('skip-override')] = true
;(lynktraceFastifyPlugin as any)[Symbol.for('fastify.display-name')] = 'lynktrace-fastify'

function captureFastifyCompletion(
  request: FastifyRequest,
  reply: FastifyReply,
  state: LynkTraceFastifyState,
): void {
  if (state.captured) return
  state.captured = true

  const statusCode = reply.statusCode ?? reply.raw?.statusCode ?? 0
  const latencyMs = Date.now() - state.startTime
  const responseSize = extractContentLength(reply.getHeader?.('content-length'))
  const rawBody = request.body
  const rawHeaders = request.headers
  const rawQuery = request.query
  const route = normalizeRoute(request)
  const method = request.method

  // Release request/reply closure references from context extra (BUG-11)
  if (state.store.extra) {
    const extra = state.store.extra as Record<string, unknown>
    extra.statusCode = statusCode
    extra.getStatusCode = () => statusCode
    extra.getMethod = () => method
    extra.getUrl = () => request.url
    extra.getRoute = () => route
  }

  const currentActiveSpan = trace.getActiveSpan() ?? state.activeSpan
  if (currentActiveSpan) {
    const enrichmentAttrs: Record<string, string | number | boolean> = {
      'http.route': route,
      'http.status_code': statusCode,
      'lynktrace.request_id': state.requestId,
      'lynktrace.latency_ms': latencyMs,
      'pulse.request_id': state.requestId,
      'pulse.latency_ms': latencyMs,
    }
    if (state.tenantId) {
      enrichmentAttrs['lynktrace.tenant_id'] = state.tenantId
      enrichmentAttrs['pulse.tenant_id'] = state.tenantId
    }
    if (state.userId) {
      enrichmentAttrs['lynktrace.user_id'] = state.userId
      enrichmentAttrs['pulse.user_id'] = state.userId
    }
    if (state.sessionId) {
      enrichmentAttrs['lynktrace.session_id'] = state.sessionId
      enrichmentAttrs['pulse.session_id'] = state.sessionId
    }
    if (state.clientIp) enrichmentAttrs['http.client_ip'] = state.clientIp
    if (state.userAgent) enrichmentAttrs['http.user_agent'] = state.userAgent
    if (state.referer) enrichmentAttrs['http.referer'] = state.referer
    if (responseSize !== undefined) enrichmentAttrs['http.response.body.size'] = responseSize
    currentActiveSpan.setAttributes(enrichmentAttrs)

    if (statusCode >= 500) {
      currentActiveSpan.setStatus({ code: SpanStatusCode.ERROR })
    } else if (statusCode >= 100 && statusCode < 400) {
      currentActiveSpan.setStatus({ code: SpanStatusCode.OK })
    }
  }

  if (state.createdServerSpan && state.activeSpan) {
    const serverSpan = state.activeSpan
    const traceId = serverSpan.spanContext().traceId
    let ended = false
    const endFastifySpan = () => {
      if (ended) return
      ended = true
      try {
        serverSpan.end()
      } catch (endErr) {
        getLogger().error('Failed to end Fastify server span', { error: endErr })
      }
    }

    const aggregator = getTraceAggregator()
    if (aggregator.getActiveSpanCount(traceId) > 1) {
      aggregator.waitForActiveChildren(traceId, endFastifySpan, 10000)
    } else {
      endFastifySpan()
    }
  }

  // SEC-05: Defer heavy body snapshotting, PII scrubbing, and captureRequest
  // via setImmediate so the HTTP response cycle returns instantly to the event loop.
  setImmediate(() => {
    withContext(state.store, () => {
      try {
        const bodySnapshot = captureBodySnapshot(rawBody, state.captureBody)
        if (currentActiveSpan && bodySnapshot.bodySize !== undefined) {
          try {
            currentActiveSpan.setAttribute('http.request.body.size', bodySnapshot.bodySize)
          } catch {}
        }

        captureRequest({
          type: 'request',
          requestId: state.requestId,
          method,
          url: route,
          statusCode,
          latency: latencyMs,
          timestamp: Date.now(),
          traceId: getTraceId() ?? state.store.traceId ?? state.activeSpan?.spanContext().traceId,
          spanId: getSpanId() ?? state.store.spanId ?? state.activeSpan?.spanContext().spanId,
          ...(state.userId ? { userId: state.userId } : {}),
          ...(state.tenantId ? { tenantId: state.tenantId } : {}),
          ...(state.sessionId ? { sessionId: state.sessionId } : {}),
          ...(state.clientIp ? { clientIp: state.clientIp } : {}),
          ...(state.userAgent ? { userAgent: state.userAgent } : {}),
          ...(state.referer ? { referer: state.referer } : {}),
          ...(state.captureHeaders ? { headers: scrubHeadersSafe(rawHeaders) } : {}),
          ...(state.captureQuery && isRecord(rawQuery) ? { query: scrubQuery(rawQuery) } : {}),
          ...(bodySnapshot.body ? { body: bodySnapshot.body } : {}),
          ...(bodySnapshot.bodySize !== undefined ? { bodySize: bodySnapshot.bodySize } : {}),
          ...(responseSize !== undefined ? { responseSize } : {}),
          route,
        })
      } catch (err) {
        getLogger().error('captureFastifyCompletion deferred capture failed', { error: err })
      }
    })
  })
}

function normalizeRoute(request: FastifyRequest): string {
  return request.routeOptions?.url ?? request.routerPath ?? request.url.split('?')[0] ?? '/'
}

function extractUserId(request: FastifyRequest): string | undefined {
  const value = request.user?.id ?? request.user?.userId
  return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined
}

function scrubHeadersSafe(headers: FastifyRequest['headers']): Record<string, unknown> {
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

function extractContentLength(value: number | string | string[] | undefined): number | undefined {
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
