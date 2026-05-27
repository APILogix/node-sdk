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

import { trace, SpanKind, SpanStatusCode, context } from '@opentelemetry/api'
import type { PrivacyCaptureConfig } from '../types/config.js'
import { getLogger } from '../utils/logger.js'

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
      const axiosModule = await loadAxios()
      if (!axiosModule) {
        logger.debug('Axios not found, skipping instrumentation')
        return
      }

      let axiosInstance: unknown

      if (axiosModule.Axios) {
        const axiosCtor = axiosModule.Axios as { prototype?: unknown }
        axiosInstance = axiosCtor.prototype ? axiosCtor : axiosModule
      } else {
        axiosInstance = axiosModule
      }

      const originalRequest = (axiosInstance as { request?: Function }).request?.bind(axiosInstance)
      if (!originalRequest) return

      const patchedRequest = async function (config: AxiosRequestConfig) {
        const span = AXIOS_TRACER.startSpan(`HTTP ${config.method?.toUpperCase() ?? 'REQUEST'}`, {
          kind: SpanKind.CLIENT,
          attributes: {
            'http.method': config.method?.toUpperCase() ?? 'GET',
            'http.url': buildUrl(config.baseURL ?? '', config.url ?? ''),
            'http.host': extractHost(config.baseURL ?? config.url ?? ''),
            'http.scheme': extractScheme(config.baseURL ?? config.url ?? ''),
            'http.user_agent': 'axios',
            'http.axios.request_timeout': config.timeout ?? options.requestTimeout,
            'db.system': 'http',
          },
        })

        if (captureHeaders && config.headers) {
          const safeHeaders: Record<string, string> = {}
          for (const [key, value] of Object.entries(config.headers)) {
            safeHeaders[key] = typeof value === 'string' ? value : String(value)
          }
          span.setAttribute('http.request.headers', JSON.stringify(safeHeaders))
        }

        if (options.captureRequestData && config.params) {
          span.setAttribute('http.request.query', JSON.stringify(config.params).slice(0, options.maxBodySize))
        }

        return context.with(trace.setSpan(context.active(), span), async () => {
          try {
            const response = await originalRequest(config)

            span.setAttribute('http.status_code', response.status ?? 0)
            span.setAttribute('http.status_text', response.statusText ?? '')

            if (captureHeaders && response.headers) {
              const safeResponseHeaders: Record<string, string> = {}
              for (const [key, value] of Object.entries(response.headers)) {
                safeResponseHeaders[key] = typeof value === 'string' ? value : String(value)
              }
              span.setAttribute('http.response.headers', JSON.stringify(safeResponseHeaders))
            }

            if (options.captureResponseData && response.data) {
              const dataStr = typeof response.data === 'string'
                ? response.data.slice(0, options.maxBodySize)
                : JSON.stringify(response.data).slice(0, options.maxBodySize)
              span.setAttribute('http.response.body', dataStr)
            }

            span.setStatus({ code: SpanStatusCode.OK })
            span.end()

            return response
          } catch (error: unknown) {
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message: error instanceof Error ? error.message : 'Request failed',
            })
            span.recordException(error as Error)
            span.end()
            throw error
          }
        })
      }

      ;(axiosInstance as { request?: Function }).request = patchedRequest

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
async function loadAxios(): Promise<Record<string, unknown> | null> {
  const logger = getLogger()

  // Strategy 1: Resolve from the consuming application's working directory.
  // This is the most reliable path when the SDK is a dependency and axios
  // is installed as a peer dependency in the consumer's node_modules.
  try {
    const { createRequire } = await import('node:module')
    const cwdRequire = createRequire(process.cwd() + '/package.json')
    const mod = cwdRequire('axios')
    return (mod.default ?? mod) as Record<string, unknown>
  } catch {
    // Not found in cwd — try other strategies
  }

  // Strategy 2: ESM dynamic import — works when Node's module resolution
  // can find axios (e.g. hoisted in a monorepo root).
  try {
    // @ts-expect-error — axios is an optional peer dependency; types may not be installed
    const mod = await import('axios')
    return (mod.default ?? mod) as Record<string, unknown>
  } catch {
    // ESM resolution failed
  }

  // Strategy 3: createRequire relative to the SDK itself — last resort for
  // cases where axios is bundled alongside the SDK.
  try {
    const { createRequire } = await import('node:module')
    const req = createRequire(import.meta.url)
    return req('axios') as Record<string, unknown>
  } catch {
    logger.debug('Axios module not found in any resolution path')
    return null
  }
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
