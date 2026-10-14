import { context } from '@opentelemetry/api'
import { suppressTracing } from '@opentelemetry/core'
import { resolveApiBaseUrl } from '../constants/defaults.js'
import type { RemoteConfigResponse } from '../types/config.js'
import { SDKError, toError } from './errors.js'
import { validateApiKey } from './api-key.js'
import { hmacSha256, sha256 } from '../utils/hash.js'
import { getLogger } from '../utils/logger.js'
import { isRetryableError } from './retry-classifier.js'

const CONTROL_PLANE_TIMEOUT_MS = 5_000
const INIT_TIMEOUT_MS = 3_000
const DEFAULT_INIT_RETRIES = 2
const MAX_INIT_RETRIES = 3
const INIT_RETRY_BASE_DELAY_MS = 150
const INIT_RETRY_MAX_DELAY_MS = 1_000
const CONTROL_PLANE_PATH_PREFIX = ''

export interface InitResponse {
  readonly success: boolean
  readonly projectId: string
  readonly organizationId?: string | undefined
  readonly environmentId?: string | undefined
  readonly environment: string
  readonly release: string
  readonly project?: Readonly<Record<string, unknown>> | undefined
  readonly configRevision?: number | null | undefined
  readonly configHash?: string | null | undefined
  readonly config: RemoteConfigResponse
}

interface RemoteConfigClientOptions {
  readonly apiKey: string
  readonly initTimeoutMs?: number | undefined
  readonly initRetries?: number | undefined
  readonly baseUrl?: string | undefined
  readonly timeoutMs?: number | undefined
  readonly fetchImpl?: typeof fetch | undefined
}

/**
 * The SDK's sole control-plane network client.
 *
 * It intentionally knows only two operations. Startup has a bounded retry for
 * transient failures; refreshes neither retry nor poll.
 */
export class RemoteConfigClient {
  private readonly apiKey: string
  private readonly baseUrl: string
  private readonly timeoutMs: number
  private readonly initTimeoutMs: number
  private readonly initRetries: number
  private readonly fetchImpl: typeof fetch

  constructor(options: RemoteConfigClientOptions) {
    validateApiKey(options.apiKey)
    this.apiKey = options.apiKey
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? resolveApiBaseUrl())
    this.timeoutMs = options.timeoutMs ?? CONTROL_PLANE_TIMEOUT_MS
    this.initTimeoutMs = options.initTimeoutMs ?? options.timeoutMs ?? INIT_TIMEOUT_MS
    this.initRetries = Math.floor(Math.min(MAX_INIT_RETRIES, Math.max(0, options.initRetries ?? DEFAULT_INIT_RETRIES)))
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  /** Perform the one and only startup request. */
  async initialize(): Promise<InitResponse> {
    const payload = await this.postInitWithRetry()
    const normalized = normalizeInitResponse(payload)
    if (!normalized) {
      throw new SDKError(
        'Init response is missing project, environment, release, or complete configuration',
        'INVALID_INIT_RESPONSE',
      )
    }

    const sdk = normalized.config.sdk
    if (!isRecord(sdk)
      || normalized.projectId !== sdk['projectId']
      || normalized.environment !== sdk['environment']
      || normalized.release !== sdk['release']) {
      throw new SDKError(
        'Init response identity does not match config.sdk',
        'INVALID_INIT_RESPONSE',
      )
    }

    getLogger().info('[RemoteConfigClient] Init response accepted', {
      endpoint: '/v1/init',
      success: normalized.success,
      projectId: normalized.projectId,
      organizationId: normalized.organizationId,
      environmentId: normalized.environmentId,
      environment: normalized.environment,
      release: normalized.release,
      configRevision: normalized.configRevision,
      configHash: normalized.configHash,
    })

    return normalized
  }

  /** Download a complete replacement snapshot after a telemetry change signal or TTL expiry. */
  async fetchLatest(currentRevision?: number | null, currentHash?: string | null): Promise<unknown> {
    const extraHeaders: Record<string, string> = {}
    if (currentHash) {
      extraHeaders['If-None-Match'] = currentHash
      extraHeaders['X-Config-Hash'] = currentHash
    }
    if (typeof currentRevision === 'number' && Number.isFinite(currentRevision)) {
      extraHeaders['X-Config-Revision'] = String(currentRevision)
    }
    const payload = await this.post('/v1/sdk-config', undefined, extraHeaders)
    if (isRecord(payload) && payload['same'] === true) return payload
    // Accept either a direct config document or a small { config } envelope.
    // No partial/patch form is supported.
    if (isRecord(payload) && 'config' in payload) return payload['config']
    return payload
  }

  /**
   * Retries only transient startup failures. The configured init timeout is a
   * deadline for the entire sequence, not a timeout per attempt, so enabling
   * reliability never turns a 1.5s startup budget into a multi-second stall.
   */
  private async postInitWithRetry(): Promise<unknown> {
    const startedAt = Date.now()
    let lastError: unknown

    for (let attempt = 0; attempt <= this.initRetries; attempt++) {
      const elapsedMs = Date.now() - startedAt
      const remainingMs = this.initTimeoutMs - elapsedMs
      if (remainingMs <= 0) break

      // Reserve an equal share of the remaining deadline for every attempt
      // that has not run yet. This gives a retry a real chance after a stalled
      // first request while retaining the caller's overall startup bound.
      const attemptsRemaining = this.initRetries - attempt + 1
      const attemptTimeoutMs = Math.max(1, Math.floor(remainingMs / attemptsRemaining))
      try {
        return await this.post('/v1/init', attemptTimeoutMs)
      } catch (error) {
        lastError = error
        if (attempt === this.initRetries || !isRetryableError(error)) throw error

        const afterAttemptMs = this.initTimeoutMs - (Date.now() - startedAt)
        if (afterAttemptMs <= 1) break
        const retryAfterMs = retryAfterFrom(error)
        // Respect a server-directed retry delay when it still fits in the
        // caller's deadline. Waiting longer would make the SDK miss startup
        // readiness without providing another useful attempt.
        if (retryAfterMs !== undefined && retryAfterMs >= afterAttemptMs) throw error
        const baseExponential = Math.min(
          INIT_RETRY_MAX_DELAY_MS,
          INIT_RETRY_BASE_DELAY_MS * (2 ** attempt),
        )
        const jitterMultiplier = 0.5 + Math.random()
        const jitteredDelay = Math.round(baseExponential * jitterMultiplier)
        const delayMs = retryAfterMs ?? Math.min(
          jitteredDelay,
          Math.max(1, Math.floor(afterAttemptMs / 2)),
        )
        getLogger().warn('[RemoteConfigClient] Retrying transient init failure', {
          endpoint: '/v1/init',
          attempt: attempt + 1,
          retryInMs: delayMs,
          remainingMs: afterAttemptMs,
          errorCode: error instanceof SDKError ? error.code : undefined,
        })
        await delay(delayMs)
      }
    }

    if (lastError) throw lastError
    throw new SDKError('Control-plane request timed out', 'NETWORK_ERROR', {
      reason: 'timeout',
      timeoutMs: this.initTimeoutMs,
    })
  }

  private async post(
    path: '/v1/init' | '/v1/sdk-config',
    timeoutOverrideMs?: number,
    extraHeaders?: Record<string, string>,
  ): Promise<unknown> {
    const controller = new AbortController()
    const timeoutMs = timeoutOverrideMs ?? (path === '/v1/init' ? this.initTimeoutMs : this.timeoutMs)
    let timer: ReturnType<typeof setTimeout>
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new SDKError('Control-plane request timed out', 'NETWORK_ERROR', { reason: 'timeout', timeoutMs }))
        controller.abort()
      }, timeoutMs)
    })
    // Keep startup alive until its bounded result, including top-level await.
    const url = `${this.baseUrl}${CONTROL_PLANE_PATH_PREFIX}${path}`

    try {
      const startedAt = Date.now()
      getLogger().debug('[RemoteConfigClient] Control-plane request started', {
        endpoint: `${CONTROL_PLANE_PATH_PREFIX}${path}`,
        url,
        method: 'POST',
      })

      // Application metadata, capabilities, versions, and local overrides are
      // not configuration inputs; the backend resolves all policy from the API key.
      const response = await Promise.race([deadline, context.with(suppressTracing(context.active()), () =>
        this.fetchImpl(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Connection': 'keep-alive',
            'x-pulse-internal': '1',
            'X-API-Key': this.apiKey,
            ...(extraHeaders ?? {}),
          },
          body: JSON.stringify({}),
          signal: controller.signal,
          redirect: 'manual',
        }),
      )])

      if (response.status === 304) {
        return { same: true }
      }

      const text = await Promise.race([deadline, response.text()])
      const latencyMs = Date.now() - startedAt
      getLogger().debug('[RemoteConfigClient] Control-plane response received', {
        endpoint: `${CONTROL_PLANE_PATH_PREFIX}${path}`,
        statusCode: response.status,
        ok: response.ok,
        latencyMs,
        responseBytes: Buffer.byteLength(text),
        contentType: response.headers.get('content-type') ?? undefined,
      })
      let payload: unknown = null
      if (text) {
        try {
          payload = JSON.parse(text)
        } catch (error) {
          throw new SDKError('Control-plane response was not valid JSON', 'INVALID_JSON', {
            statusCode: response.status,
          }, error)
        }
      }
      if (path === '/v1/init') {
        getLogger().debug('[RemoteConfigClient] Init route response served', summarizeInitRoutePayload(payload))
      }
      if (!response.ok) {
        const retryAfter = retryAfterMs(response.headers.get('retry-after'))
        throw new SDKError('Control-plane request failed', 'HTTP_ERROR', {
          statusCode: response.status,
          status: response.status,
          ...(retryAfter !== undefined
            ? { retryAfterMs: retryAfter }
            : {}),
        })
      }

      return payload
    } catch (error) {
      if (error instanceof SDKError) throw error
      const normalized = toError(error)
      throw new SDKError('Control-plane request failed', 'NETWORK_ERROR', {
        reason: normalized.name === 'AbortError' ? 'timeout' : normalized.message,
      }, normalized)
    } finally {
      clearTimeout(timer!)
    }
  }
}

function summarizeInitRoutePayload(payload: unknown): Record<string, unknown> {
  const summary: Record<string, unknown> = {
    endpoint: '/v1/init',
    responseType: payload === null ? 'null' : Array.isArray(payload) ? 'array' : typeof payload,
  }
  if (!isRecord(payload)) return summary

  const config = isRecord(payload['config']) ? payload['config'] : undefined
  const sdk = config && isRecord(config['sdk']) ? config['sdk'] : undefined
  const meta = config && isRecord(config['meta']) ? config['meta'] : undefined

  return {
    ...summary,
    success: payload['success'],
    projectId: payload['projectId'] ?? sdk?.['projectId'],
    organizationId: payload['organizationId'],
    environmentId: payload['environmentId'],
    environment: payload['environment'] ?? sdk?.['environment'],
    release: payload['release'] ?? sdk?.['release'],
    configRevision: payload['configRevision'],
    configHash: payload['configHash'] ?? meta?.['configHash'],
    configSections: config ? Object.keys(config).sort() : undefined,
  }
}

function normalizeBaseUrl(value: string): string {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new Error('unsupported protocol')
    }
    if (url.username || url.password || url.search || url.hash || (url.pathname && url.pathname !== '/')) {
      throw new Error('base URL must be an origin')
    }
    if (url.hostname === 'localhost') {
      url.hostname = '127.0.0.1'
    }
    return url.origin
  } catch (error) {
    throw new SDKError('baseUrl must be an HTTP(S) origin', 'INVALID_URL', { baseUrl: value }, error)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}


function retryAfterFrom(error: unknown): number | undefined {
  if (!(error instanceof SDKError)) return undefined
  const value = error.context['retryAfterMs']
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function retryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000)
  const timestamp = Date.parse(value)
  if (!Number.isNaN(timestamp)) return Math.max(0, timestamp - Date.now())
  return undefined
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function normalizeInitResponse(payload: unknown): InitResponse | null {
  if (!isRecord(payload)) return null

  const config = extractInitConfig(payload)
  if (!isRecord(config) || !isRecord(config['sdk'])) return null

  const sdk = config['sdk']
  const meta = isRecord(config['meta']) ? config['meta'] : null
  const projectId = isNonEmptyString(payload['projectId']) ? payload['projectId'] : null
  const environment = isNonEmptyString(payload['environment']) ? payload['environment'] : null
  const release = isNonEmptyString(payload['release']) ? payload['release'] : null
  if (!projectId || !environment || !release) return null

  return {
    success: payload['success'] === undefined ? true : payload['success'] === true,
    projectId,
    ...(isNonEmptyString(payload['organizationId']) ? { organizationId: payload['organizationId'] } : {}),
    ...(isNonEmptyString(payload['environmentId']) ? { environmentId: payload['environmentId'] } : {}),
    environment,
    release,
    ...(isRecord(payload['project']) ? { project: payload['project'] } : {}),
    ...(typeof payload['configRevision'] === 'number' || payload['configRevision'] === null
      ? { configRevision: payload['configRevision'] }
      : {}),
    ...(isNonEmptyString(meta?.['configHash']) ? { configHash: meta['configHash'] } : {}),
    config: config as unknown as RemoteConfigResponse,
  }
}

function extractInitConfig(payload: Record<string, unknown>): unknown {
  if (isRecord(payload['config'])) return payload['config']
  if (isRecord(payload['body'])) return payload['body']
  if (isRecord(payload['data'])) return payload['data']
  if (isRecord(payload['sdk'])) return payload
  return null
}

function firstNonEmptyString(...values: unknown[]): string | null {
  for (const value of values) {
    if (isNonEmptyString(value)) return value
  }
  return null
}


function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}
