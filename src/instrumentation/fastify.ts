/**
 * Fastify request-capture plugin.
 *
 * Mirrors the enterprise hardening of `monitorMiddleware` for Express:
 *   - Killswitch + FeatureController gates
 *   - Tenant admission control
 *   - Centralized scrubbing via SecurityScrubber
 *   - Backend-authoritative sampling and privacy capture policy
 *
 * The plugin is intentionally fail-open. If any hook throws, the host
 * application continues serving traffic and the SDK logs the failure.
 */

import { captureError } from '../capture/captureError.js'
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
import {
  captureBodySnapshot,
  evaluateCaptureGate,
  headerString,
  matchesIgnoredPath,
  resolveClientIp,
  scrubHeaders,
  scrubQuery,
} from './request-capture-utils.js'

export interface PulseFastifyOptions {
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
  pulse?: PulseFastifyState
}

type FastifyReply = {
  statusCode?: number
  raw?: { statusCode?: number }
  getHeader?: (name: string) => string | string[] | number | undefined
}

interface PulseFastifyState {
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

export function fastifyPulsePlugin(
  fastify: FastifyInstance,
  opts: PulseFastifyOptions,
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

      const userId = readUserId(request)
      const sessionId = headerString(headers['x-session-id'])
      const userAgent = headerString(headers['user-agent'])
      const referer = headerString(headers['referer'] ?? headers['referrer'])
      const clientIp = resolveClientIp(headers, request.socket?.remoteAddress, options.trustedProxies, decision.maskIp, request.ip)

      const store = createContextStore(
        requestId,
        options.maxBreadcrumbs ?? client.options?.maxBreadcrumbs ?? 100,
        {
          userId,
          sessionId,
          extra: {
            ...(tenantId ? { tenantId } : {}),
            getStatusCode: () => (request as any).raw?.statusCode ?? (request as any).reply?.statusCode,
            getMethod: () => request.method,
            getUrl: () => request.url,
            getRoute: () => normalizedRoute(request),
          },
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

      request.pulse = {
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
      getLogger().error('fastifyPulsePlugin onRequest failed', { error: err })
      hookDone()
    }
  })

  fastify.addHook('preHandler', (request, reply, hookDone) => {
    const state = request.pulse
    if (!state) {
      hookDone()
      return
    }

    const rawReply = reply as unknown as { send?: (...args: unknown[]) => unknown; statusCode?: number; raw?: { statusCode?: number } }
    if (typeof rawReply.send === 'function') {
      const originalSend = rawReply.send
      rawReply.send = function (this: unknown, payload?: unknown) {
        if (state && !(state.store.extra as Record<string, unknown> | undefined)?.['fastifyErrorCaptured']) {
          const errStatusCode = (payload as unknown as { statusCode?: number })?.statusCode
            ?? (rawReply.statusCode && rawReply.statusCode !== 200 ? rawReply.statusCode : undefined)
            ?? (rawReply.raw?.statusCode && rawReply.raw.statusCode !== 200 ? rawReply.raw.statusCode : undefined)
            ?? 500
          if (payload instanceof Error || (payload && typeof payload === 'object' && (payload as Record<string, unknown>).message && errStatusCode >= 400)) {
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
                captureError(payload instanceof Error ? payload : new Error(String((payload as Record<string, unknown>).message)))
              } catch (sendErr) {
                getLogger().error('fastifyPulsePlugin reply.send error capture failed', { error: sendErr })
              }
            })
          }
        }
        return originalSend.apply(this, arguments as unknown as [unknown])
      }
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
    const state = request.pulse
    if (!state) {
      hookDone()
      return
    }

    withContext(state.store, () => {
      try {
        const statusCode = reply.statusCode ?? reply.raw?.statusCode ?? 0
        if (statusCode >= 400 && !(state.store.extra as Record<string, unknown> | undefined)?.['fastifyErrorCaptured']) {
          const defaultMsg = statusCode === 422 ? 'Fastify 422 error' : statusCode === 401 ? 'Fastify 401 error' : `Fastify HTTP ${statusCode} error`
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
          captureError(err)
        }
        captureFastifyCompletion(request, reply, state)
      } catch (err) {
        getLogger().error('fastifyPulsePlugin completion failed', { error: err })
      }
      hookDone()
    })
  })

  fastify.addHook('preSerialization', (request, reply, payload, hookDone) => {
    const state = request.pulse
    if (state) {
      const errStatusCode = (payload as unknown as { statusCode?: number })?.statusCode
        ?? (reply.statusCode && reply.statusCode !== 200 ? reply.statusCode : undefined)
        ?? (reply.raw?.statusCode && reply.raw.statusCode !== 200 ? reply.raw.statusCode : undefined)
        ?? 500
      if (payload instanceof Error || (payload && typeof payload === 'object' && (payload as Record<string, unknown>).message && errStatusCode >= 400)) {
        withContext(state.store, () => {
          try {
            if (state.store.extra) {
              ;(state.store.extra as Record<string, unknown>).mechanism = 'fastify.onError'
              ;(state.store.extra as Record<string, unknown>).handled = true
              ;(state.store.extra as Record<string, unknown>).statusCode = errStatusCode
              ;(state.store.extra as Record<string, unknown>).getStatusCode = () => errStatusCode
            }
            attachRequestContextToActiveSpan(state.store)
            captureError(payload instanceof Error ? payload : new Error(String((payload as Record<string, unknown>).message)))
          } catch (err) {
            getLogger().error('fastifyPulsePlugin preSerialization error capture failed', { error: err })
          }
        })
      }
    }
    hookDone(null, payload)
  })

  fastify.addHook('onError', (request, reply, error, hookDone) => {
    const state = request.pulse
    if (!state) {
      if (typeof hookDone === 'function') hookDone()
      return
    }

    const errStatusCode = (error as unknown as { statusCode?: number; status?: number })?.statusCode
      ?? (error as unknown as { statusCode?: number; status?: number })?.status
      ?? (reply.statusCode && reply.statusCode !== 200 ? reply.statusCode : undefined)
      ?? (reply.raw?.statusCode && reply.raw.statusCode !== 200 ? reply.raw.statusCode : undefined)
      ?? 500

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
        captureError(error)
        const currentActiveSpan = trace.getActiveSpan() ?? state.activeSpan
        if (currentActiveSpan) {
          try {
            currentActiveSpan.recordException(error)
            currentActiveSpan.setStatus({ code: SpanStatusCode.ERROR, message: error.message })
          } catch { /* fail-open */ }
        }
      } catch (err) {
        getLogger().error('fastifyPulsePlugin error capture failed', { error: err })
      }
      if (typeof hookDone === 'function') hookDone()
    })
  })

  fastify.addHook('onSend', (request, reply, payload, hookDone) => {
    const state = request.pulse
    if (state && !(state.store.extra as Record<string, unknown> | undefined)?.['fastifyErrorCaptured']) {
      let errToCapture: Error | null = null
      let statusCode = reply.statusCode ?? reply.raw?.statusCode ?? 200

      if (payload instanceof Error) {
        errToCapture = payload
        statusCode = (payload as unknown as { statusCode?: number }).statusCode ?? statusCode
      } else {
        let payloadStr = ''
        if (typeof payload === 'string') {
          payloadStr = payload
        } else if (Buffer.isBuffer(payload)) {
          payloadStr = payload.toString('utf8')
        } else if (payload && typeof payload === 'object') {
          const obj = payload as Record<string, unknown>
          if (typeof obj['statusCode'] === 'number') {
            statusCode = obj['statusCode'] as number
          }
          if (typeof obj['message'] === 'string' && statusCode >= 400) {
            errToCapture = new Error(String(obj['message']))
          }
        }

        if (payloadStr) {
          try {
            const parsed = JSON.parse(payloadStr) as Record<string, unknown>
            if (parsed && typeof parsed === 'object') {
              if (typeof parsed['statusCode'] === 'number') {
                statusCode = parsed['statusCode'] as number
              }
              if (typeof parsed['message'] === 'string' && statusCode >= 400) {
                errToCapture = new Error(parsed['message'] as string)
              }
            }
          } catch {}
        }
      }

      if (errToCapture && statusCode >= 400) {
        withContext(state.store, () => {
          try {
            if (state.store.extra) {
              ;(state.store.extra as Record<string, unknown>).mechanism = 'fastify.onError'
              ;(state.store.extra as Record<string, unknown>).handled = true
              ;(state.store.extra as Record<string, unknown>).statusCode = statusCode
              ;(state.store.extra as Record<string, unknown>).getStatusCode = () => statusCode
              ;(state.store.extra as Record<string, unknown>).fastifyErrorCaptured = true
            }
            attachRequestContextToActiveSpan(state.store)
            captureError(errToCapture)
          } catch (err) {
            getLogger().error('fastifyPulsePlugin onSend error capture failed', { error: err })
          }
        })
      }
    }
    hookDone(null, payload)
  })

  if (typeof (fastify as unknown as { setErrorHandler?: unknown }).setErrorHandler === 'function') {
    const defaultErrorHandler = (fastify as unknown as { errorHandler?: (err: Error, req: FastifyRequest, rep: FastifyReply) => unknown }).errorHandler
    ;(fastify as unknown as { setErrorHandler: (fn: (this: unknown, error: Error, request: FastifyRequest, reply: FastifyReply) => unknown) => void }).setErrorHandler(function (this: unknown, error: Error, request: FastifyRequest, reply: FastifyReply) {
      const state = request.pulse
      if (state) {
        const errStatusCode = (error as unknown as { statusCode?: number; status?: number })?.statusCode
          ?? (error as unknown as { statusCode?: number; status?: number })?.status
          ?? (reply.statusCode && reply.statusCode !== 200 ? reply.statusCode : undefined)
          ?? (reply.raw?.statusCode && reply.raw.statusCode !== 200 ? reply.raw.statusCode : undefined)
          ?? 500
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
            captureError(error)
          } catch (err) {
            getLogger().error('fastifyPulsePlugin errorHandler error capture failed', { error: err })
          }
        })
      }
      if (typeof defaultErrorHandler === 'function') {
        return defaultErrorHandler.call(this, error, request, reply)
      }
      if (typeof (reply as unknown as { send?: unknown }).send === 'function') {
        (reply as unknown as { send: (payload: unknown) => unknown }).send(error)
      }
    })
  }

  done()
}

;(fastifyPulsePlugin as any)[Symbol.for('skip-override')] = true
;(fastifyPulsePlugin as any)[Symbol.for('fastify.display-name')] = 'pulse-fastify'

function captureFastifyCompletion(
  request: FastifyRequest,
  reply: FastifyReply,
  state: PulseFastifyState,
): void {
  if (state.captured) return
  state.captured = true

  const statusCode = reply.statusCode ?? reply.raw?.statusCode ?? 0
  const bodySnapshot = captureBodySnapshot(request.body, state.captureBody)
  const responseSize = readContentLength(reply.getHeader?.('content-length'))

  const currentActiveSpan = trace.getActiveSpan() ?? state.activeSpan
  if (currentActiveSpan) {
    const route = normalizedRoute(request)
    const enrichmentAttrs: Record<string, string | number | boolean> = {
      'http.route': route,
      'http.status_code': statusCode,
      'pulse.request_id': state.requestId,
      'pulse.latency_ms': Date.now() - state.startTime,
    }
    if (state.tenantId) enrichmentAttrs['pulse.tenant_id'] = state.tenantId
    if (state.userId) enrichmentAttrs['pulse.user_id'] = state.userId
    if (state.sessionId) enrichmentAttrs['pulse.session_id'] = state.sessionId
    if (state.clientIp) enrichmentAttrs['http.client_ip'] = state.clientIp
    if (state.userAgent) enrichmentAttrs['http.user_agent'] = state.userAgent
    if (state.referer) enrichmentAttrs['http.referer'] = state.referer
    if (bodySnapshot.bodySize !== undefined) enrichmentAttrs['http.request.body.size'] = bodySnapshot.bodySize
    if (responseSize !== undefined) enrichmentAttrs['http.response.body.size'] = responseSize
    currentActiveSpan.setAttributes(enrichmentAttrs)

    if (statusCode >= 500) {
      currentActiveSpan.setStatus({ code: SpanStatusCode.ERROR })
    } else if (statusCode >= 100 && statusCode < 400) {
      currentActiveSpan.setStatus({ code: SpanStatusCode.OK })
    }
  }

  if (state.createdServerSpan && state.activeSpan) {
    try {
      state.activeSpan.end()
    } catch (endErr) {
      getLogger().error('Failed to end Fastify server span', { error: endErr })
    }
  }

  captureRequest({
    type: 'request',
    requestId: state.requestId,
    method: request.method,
    url: normalizedRoute(request),
    statusCode,
    latency: Date.now() - state.startTime,
    timestamp: Date.now(),
    traceId: getTraceId() ?? state.store.traceId ?? state.activeSpan?.spanContext().traceId,
    spanId: getSpanId() ?? state.store.spanId ?? state.activeSpan?.spanContext().spanId,
    ...(state.userId ? { userId: state.userId } : {}),
    ...(state.tenantId ? { tenantId: state.tenantId } : {}),
    ...(state.sessionId ? { sessionId: state.sessionId } : {}),
    ...(state.clientIp ? { clientIp: state.clientIp } : {}),
    ...(state.userAgent ? { userAgent: state.userAgent } : {}),
    ...(state.referer ? { referer: state.referer } : {}),
    ...(state.captureHeaders ? { headers: scrubHeadersSafe(request.headers) } : {}),
    ...(state.captureQuery && isRecord(request.query) ? { query: scrubQuery(request.query) } : {}),
    ...(bodySnapshot.body ? { body: bodySnapshot.body } : {}),
    ...(bodySnapshot.bodySize !== undefined ? { bodySize: bodySnapshot.bodySize } : {}),
    ...(responseSize !== undefined ? { responseSize } : {}),
    route: normalizedRoute(request),
  })
}

function normalizedRoute(request: FastifyRequest): string {
  return request.routeOptions?.url ?? request.routerPath ?? request.url.split('?')[0] ?? '/'
}

function readUserId(request: FastifyRequest): string | undefined {
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
