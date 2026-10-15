/**
 * HTTP transport — low-level POST with compression, signing, and rate-limit header parsing.
 */

import { SDKError, toError } from '../core/errors.js'
import { getLogger } from '../utils/logger.js'
import { compress, contentEncoding, type CompressionAlgorithm } from '../utils/compression.js'
import { generateId } from '../utils/uuid.js'
import { context } from '@opentelemetry/api'
import { suppressTracing } from '@opentelemetry/core'
import { SerializationPool } from './serialization-pool.js'
import { safeJsonStringify } from '../utils/safe-json.js'

export interface PostJsonOptions {
  /** Whether to log failures (disable for init to avoid noise). */
  logFailures?: boolean
  /** Compression algorithm to use. Defaults to 'none'. */
  compression?: CompressionAlgorithm
  /** Extra headers to include. */
  extraHeaders?: Record<string, string>
  /** Observe a successful parsed response after normal response processing. */
  onResponse?: (statusCode: number, payload: unknown) => void
}

export interface HttpResponse<T> {
  data: T
  statusCode: number
  retryAfterMs?: number
  rateLimitRemaining?: number
}

export async function postJson<T>(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  timeoutMs: number,
  options: PostJsonOptions = {},
): Promise<T> {
  const logger = getLogger()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  timeout.unref?.()
  const startedAt = Date.now()
  const requestId = generateId()

  logger.debug('HTTP request started', {
    method: 'POST',
    requestId,
    compression: options.compression ?? 'none',
  })

  try {
    // Serialize body
    let payload: string | Uint8Array
    let encoding: string | undefined

    if (Buffer.isBuffer(body) || body instanceof Uint8Array) {
      payload = body as Uint8Array
    } else {
      const pool = SerializationPool.getInstance()
      if (pool && Array.isArray(body)) {
        const res = await pool.serialize(body, options.compression ?? 'none')
        payload = new Uint8Array(res.buffer)
        if (res.algorithm !== 'none') {
          encoding = contentEncoding(res.algorithm)
        }
      } else {
        const jsonString = safeJsonStringify(body)
        payload = jsonString

        // Apply compression if requested
        if (options.compression && options.compression !== 'none') {
          const jsonBuffer = Buffer.from(jsonString)
          const compressed = await compress(jsonBuffer, options.compression)

          if (compressed.algorithm !== 'none') {
            payload = new Uint8Array(compressed.buffer)
            encoding = contentEncoding(compressed.algorithm)

            logger.debug('Payload compressed', {
              algorithm: compressed.algorithm,
              ratio: (compressed.compressedSize / compressed.originalSize).toFixed(2),
            })
          }
        }
      }
    }

    // Build headers
    const requestHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Request-ID': requestId,
      ...headers,
      ...(options.extraHeaders ?? {}),
    }

    if (encoding) {
      requestHeaders['Content-Encoding'] = encoding
    }

    const response = await context.with(suppressTracing(context.active()), () =>
      fetch(url, {
        method: 'POST',
        headers: {
          ...requestHeaders,
          'x-pulse-internal': '1',
        },
        body: payload as BodyInit,
        signal: controller.signal,
      })
    )

    const text = await response.text()
    const parsed = text ? tryParseJson(text) : null
    const durationMs = Date.now() - startedAt

    logger.debug('HTTP response received', {
      statusCode: response.status,
      durationMs,
      requestId,
    })

    if (!response.ok) {
      throw new SDKError('HTTP request failed', 'HTTP_ERROR', {
        status: response.status,
        statusCode: response.status,
        requestId,
      })
    }

    if (text && parsed === undefined) {
      throw new SDKError('Invalid JSON response', 'INVALID_JSON', {
        status: response.status,
        statusCode: response.status,
        requestId,
      })
    }

    if (options.onResponse) {
      try {
        options.onResponse(response.status, parsed)
      } catch (error) {
        logger.debug('HTTP response observer failed', { error })
      }
    }

    return parsed as T
  } catch (error) {
    if (error instanceof SDKError) {
      logFailure(logger, error, startedAt, requestId, options)
      throw error
    }

    const normalized = toError(error)
    const sdkError = new SDKError('Network request failed', 'NETWORK_ERROR', {
      reason: normalized.name === 'AbortError' ? 'timeout' : normalized.message,
      requestId,
    }, normalized)
    logFailure(logger, sdkError, startedAt, requestId, options)
    throw sdkError
  } finally {
    clearTimeout(timeout)
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function logFailure(
  logger: ReturnType<typeof getLogger>,
  error: SDKError,
  startedAt: number,
  requestId: string,
  options: PostJsonOptions,
): void {
  if (options.logFailures === false) return

  logger.error('HTTP request failed', {
    error,
    method: 'POST',
    statusCode: error.context['statusCode'],
    durationMs: Date.now() - startedAt,
    requestId,
  })
}

function tryParseJson(text: string): unknown | undefined {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

