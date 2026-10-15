/**
 * Axios Instrumentation — OpenTelemetry-compatible HTTP client instrumentation
 * wrapped with Pulse SDK guards and remote config support.
 *
 * Axios is an HTTP client that wraps node:http/https. This instrumentation
 * ensures axios requests are properly traced with axios-specific attributes.
 *
 * Features:
 * - Automatic span creation for axios requests
 * - Request/response interceptors for tracing
 * - Axios-specific span attributes (config, headers)
 * - Error tracking with response context
 * - Request timeout tracking
 * - Multipart form data handling
 *
 * Note: Since axios uses node:http/https internally, the OTel HttpInstrumentation
 * already captures these requests. This module adds axios-specific attributes
 * and ensures proper span naming conventions.
 */
import { trace, SpanKind, SpanStatusCode, context, createContextKey, propagation } from '@opentelemetry/api'
import type { PrivacyCaptureConfig } from '../types/config.js'
import { getLogger } from '../utils/logger.js'
import { SecurityScrubber } from '../processors/security-scrubber.js'
import { sanitizeHeaders } from '../processors/sanitizer.js'
import { safeJsonStringify } from '../utils/safe-json.js'

function scrubAxiosHeaders(headers: Record<string, unknown>): Record<string, unknown> {
  const scrubber = SecurityScrubber.getInstance()
  if (scrubber) {
    const scrubbed = scrubber.scrub({
      type: 'request',
      headers,
    } as unknown as import('../types/event.js').SDKEvent) as unknown as { headers?: Record<string, unknown> }
    return scrubbed.headers ?? sanitizeHeaders(headers)
  }
  return sanitizeHeaders(headers)
}

function isStreamOrBinary(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false
  if (Buffer.isBuffer(data) || data instanceof Uint8Array || data instanceof ArrayBuffer) return true
  return typeof (data as { pipe?: unknown }).pipe === 'function'
}

export const SUPPRESS_INNER_HTTP = createContextKey('pulse.suppress_inner_http')

export interface AxiosInstrumentationOptions {
  enabled: boolean
  captureRequestData?: boolean
  captureResponseData?: boolean
  requestTimeout?: number
  maxBodySize?: number
}

interface AxiosRequestConfig {
  method?: string
  url?: string
  baseURL?: string
  headers?: Record<string, string>
  params?: Record<string, unknown>
  data?: unknown
  timeout?: number
  [key: string]: unknown
}

interface AxiosResponseLike {
  status?: number
  statusText?: string
  headers?: Record<string, unknown>
  data?: unknown
}

const AXIOS_TRACER = trace.getTracer('@pulse-sdk/axios', '1.0.0')

export function createAxiosInstrumentation(
  enabled: boolean,
  mergedOptions?: Partial<AxiosInstrumentationOptions>,
  captureConfig?: PrivacyCaptureConfig
): { setup: () => Promise<void>; teardown: () => void } | null {
  if (!enabled) {
    return null
  }

  const captureBody = captureConfig?.body ?? false
  const captureHeaders = captureConfig?.headers ?? false
  const captureResponse = captureConfig?.response ?? false

  const options: Required<AxiosInstrumentationOptions> = {
    enabled: true,
    captureRequestData: mergedOptions?.captureRequestData ?? captureBody,
    captureResponseData: mergedOptions?.captureResponseData ?? captureResponse,
    requestTimeout: mergedOptions?.requestTimeout ?? 30000,
    maxBodySize: mergedOptions?.maxBodySize ?? 1024 * 1024,
  }

  const logger = getLogger()
  const requestInterceptorPatchers: Array<() => void> = []
  const responseInterceptorPatchers: Array<() => void> = []

  async function setup(): Promise<void> {
    if (typeof globalThis === 'undefined') return

    try {
      const axiosModules = await loadAxiosInstances()
      if (axiosModules.length === 0) {
        logger.debug('Axios not found, skipping instrumentation')
        return
      }

      const patchTargets: Record<string, unknown>[] = []
      const seenTargets = new Set<Record<string, unknown>>()

      for (const axiosModule of axiosModules) {
        const axiosCtor = axiosModule.Axios as { prototype?: Record<string, unknown> } | undefined
        if (axiosCtor?.prototype && typeof axiosCtor.prototype['request'] === 'function') {
          if (!seenTargets.has(axiosCtor.prototype)) {
            seenTargets.add(axiosCtor.prototype)
            patchTargets.push(axiosCtor.prototype)
          }
        } else if (typeof axiosModule['request'] === 'function' && !seenTargets.has(axiosModule)) {
          seenTargets.add(axiosModule)
          patchTargets.push(axiosModule)
        }
      }

      if (patchTargets.length === 0) return

      for (const target of patchTargets) {
        const originalRequest = target['request'] as (this: unknown, config: AxiosRequestConfig) => Promise<AxiosResponseLike>

        const patchedRequest = async function (this: unknown, config: AxiosRequestConfig) {
          const span = AXIOS_TRACER.startSpan(`HTTP ${config.method?.toUpperCase() ?? 'REQUEST'}`, {
            kind: SpanKind.CLIENT,
            attributes: {
              'http.method': config.method?.toUpperCase() ?? 'GET',
              'http.url': buildUrl(config.baseURL ?? '', config.url ?? ''),
              'http.host': extractHost(config.baseURL ?? config.url ?? ''),
              'http.scheme': extractScheme(config.baseURL ?? config.url ?? ''),
              'http.user_agent': 'axios',
              'http.axios.request_timeout': config.timeout ?? options.requestTimeout,
            },
          })

          if (!config.headers) {
            config.headers = {}
          }

          if (captureHeaders && config.headers && typeof config.headers === 'object') {
            try {
              span.setAttribute('http.request.headers', safeJsonStringify(scrubAxiosHeaders(config.headers)))
            } catch {
              // Fail-open: never block request on header serialization
            }
          }

          if (options.captureRequestData && config.params) {
            try {
              span.setAttribute('http.request.query', safeJsonStringify(config.params).slice(0, options.maxBodySize))
            } catch {
              // Fail-open
            }
          }

          const activeContext = trace.setSpan(context.active(), span).setValue(SUPPRESS_INNER_HTTP, true)

          // W3C Trace Context Propagation:
          // Inject traceparent and tracestate into outbound Axios request headers using the active OTel context.
          // Respect existing headers and do not overwrite an explicitly supplied valid propagation header.
          let hasExplicitTraceparent = false
          if (config.headers) {
            const h = config.headers as any
            if (typeof h.has === 'function') {
              hasExplicitTraceparent = Boolean(h.has('traceparent') || h.has('Traceparent'))
            } else if (typeof h.get === 'function') {
              hasExplicitTraceparent = h.get('traceparent') != null || h.get('Traceparent') != null
            } else if (typeof h === 'object') {
              hasExplicitTraceparent = Object.keys(h).some(
                k => k.toLowerCase() === 'traceparent' && h[k] != null
              )
            }
          }

          if (!hasExplicitTraceparent) {
            propagation.inject(activeContext, config.headers, {
              set(carrier: any, key: string, value: string) {
                if (!carrier) return
                if (typeof carrier.set === 'function') {
                  carrier.set(key, value)
                } else {
                  carrier[key] = value
                }
              },
            })
          }
          return context.with(activeContext, async () => {
            let response: AxiosResponseLike
            try {
              response = await originalRequest.call(this, config)
            } catch (error: unknown) {
              try {
                span.setStatus({
                  code: SpanStatusCode.ERROR,
                  message: error instanceof Error ? error.message : 'Request failed',
                })
                if (error instanceof Error) {
                  span.recordException(error)
                }
                const errStatus = (error as { response?: { status?: number } })?.response?.status
                if (typeof errStatus === 'number') {
                  span.setAttribute('http.status_code', errStatus)
                }
              } catch {
                // Never mask original error
              } finally {
                span.end()
              }
              throw error
            }

            // Telemetry post-processing MUST be isolated from host return path
            try {
              span.setAttribute('http.status_code', response.status ?? 0)
              span.setAttribute('http.status_text', response.statusText ?? '')

              if (captureHeaders && response.headers && typeof response.headers === 'object') {
                span.setAttribute('http.response.headers', safeJsonStringify(scrubAxiosHeaders(response.headers)))
              }

              if (options.captureResponseData && response.data !== undefined && !isStreamOrBinary(response.data)) {
                const dataStr = typeof response.data === 'string'
                  ? response.data.slice(0, options.maxBodySize)
                  : safeJsonStringify(response.data).slice(0, options.maxBodySize)
                span.setAttribute('http.response.body', dataStr)
              }

              span.setStatus({ code: SpanStatusCode.OK })
            } catch {
              // Swallow telemetry serialization errors so host response always succeeds
            } finally {
              span.end()
            }

            return response
          })
        }

        target['request'] = patchedRequest
        // Registered for teardown — restores the original only when our
        // patch is still the installed one, so we never clobber a wrapper
        // another library installed on top of us.
        requestInterceptorPatchers.push(() => {
          if (target['request'] === patchedRequest) {
            target['request'] = originalRequest
          }
        })
      }

      logger.info('Axios instrumentation registered', {
        captureRequestData: options.captureRequestData,
        captureResponseData: options.captureResponseData,
      })
    } catch (error) {
      logger.warn('Failed to register Axios instrumentation', { error: String(error) })
    }
  }

  function teardown(): void {
    for (const patcher of requestInterceptorPatchers) {
      try { patcher() } catch { /* ignore */ }
    }
    for (const patcher of responseInterceptorPatchers) {
      try { patcher() } catch { /* ignore */ }
    }
    // Clear so a re-setup after teardown starts from a clean slate and
    // restore closures can't run twice.
    requestInterceptorPatchers.length = 0
    responseInterceptorPatchers.length = 0
  }

  return { setup, teardown }
}

/**
 * ESM-safe Axios loader.
 *
 * Resolution order:
 *   1. createRequire(process.cwd()) — resolves from the consuming app's
 *      node_modules, which is where axios is installed as a peer dependency.
 *   2. Dynamic import('axios') — works if Node's ESM resolver can find it.
 *   3. createRequire(import.meta.url) — resolves from the SDK's own
 *      node_modules (useful when axios is bundled with the SDK).
 *
 * The previous implementation only tried (2) and (3), both of which resolve
 * relative to the SDK package. When the SDK is `file:`-linked or installed
 * as a dependency, axios lives in the *consumer's* node_modules and neither
 * path finds it.
 */
async function loadAxiosInstances(): Promise<Array<Record<string, unknown>>> {
  const logger = getLogger()
  const instances: Array<Record<string, unknown>> = []

  // Strategy 1: ESM dynamic import — essential for ESM applications and modern test runners
  try {
    const mod = await import('axios')
    const resolved = (mod.default ?? mod) as unknown as Record<string, unknown>
    if (resolved) instances.push(resolved)
  } catch {
    // ESM resolution failed
  }

  // Strategy 2: CommonJS from the consuming application's working directory
  try {
    const { createRequire } = await import('node:module')
    const cwdRequire = createRequire(process.cwd() + '/package.json')
    const mod = cwdRequire('axios')
    const resolved = (mod.default ?? mod) as unknown as Record<string, unknown>
    if (resolved && !instances.includes(resolved)) instances.push(resolved)
  } catch {
    // Not found in cwd
  }

  // Strategy 3: CommonJS relative to the SDK itself
  try {
    const { createRequire } = await import('node:module')
    const req = createRequire(import.meta.url)
    const mod = req('axios')
    const resolved = (mod.default ?? mod) as unknown as Record<string, unknown>
    if (resolved && !instances.includes(resolved)) instances.push(resolved)
  } catch {
    // Not found relative to SDK
  }

  if (instances.length === 0) {
    logger.debug('Axios module not found in any resolution path')
  }
  return instances
}


function buildUrl(baseURL: string, url: string): string {
  if (url.startsWith('http://') || url.startsWith('https://')) {
    return url
  }
  if (baseURL) {
    return baseURL.endsWith('/') && url.startsWith('/')
      ? baseURL + url.slice(1)
      : baseURL + url
  }
  return url
}

function extractHost(url: string): string {
  try {
    const parsed = new URL(url.startsWith('http') ? url : `https://${url}`)
    return parsed.host
  } catch {
    return 'unknown'
  }
}

function extractScheme(url: string): string {
  if (url.startsWith('https://')) return 'https'
  if (url.startsWith('http://')) return 'http'
  return 'https'
}

export interface AxiosSpanAttributes {
  'http.method': string
  'http.url': string
  'http.host': string
  'http.scheme': string
  'http.user_agent': 'axios'
  'http.status_code': number
  'http.axios.request_timeout': number
  'http.request.headers'?: string
  'http.response.headers'?: string
  'http.request.query'?: string
  'http.response.body'?: string
}

export default createAxiosInstrumentation
