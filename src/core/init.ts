/**
 * SDK Initialization — the entry point for configuring and starting the SDK.
 *
 * Flow:
 * 1. Validate user options via zod schema
 * 2. Handshake with server (/v1/init) to get remote config
 * 3. Merge user options + remote config into ResolvedSDKConfig
 * 4. Initialize breadcrumb buffer, plugins, event processors
 * 5. Start batcher, register global error handlers, signal handlers
 * 6. SDK is ready — events flow through the pipeline
 */

import type { SDKInitOptions, RemoteConfig, ResolvedSDKConfig } from '../types/config.js'
import { sdkInitOptionsSchema } from '../types/config.js'
import { client } from './client.js'
import type { InitResponse } from '../transport/sender.js'
import { sendInitRequest } from '../transport/sender.js'
import { startBatcher } from '../transport/batcher.js'
import { setupGlobalErrorHandlers } from '../instrumentation/global-errors.js'
import { eventQueue } from '../transport/queue.js'
import { DEFAULT_BASE_URL, DEFAULT_MAX_PAYLOAD_BYTES, DEFAULT_MAX_RETRIES, DEFAULT_TIMEOUT_MS } from '../constants/defaults.js'
import { SDKError } from './errors.js'
import { getLogger, setDebugMode } from '../utils/logger.js'
import { initializePlugins } from '../plugins/index.js'
import { registerSignalHandlers } from './lifecycle.js'
import { sleep } from '../utils/time.js'

const INIT_MAX_ATTEMPTS = 5
const INIT_BASE_RETRY_DELAY_MS = 500
const INIT_MAX_RETRY_DELAY_MS = 5000

/**
 * Initialize the SDK.
 *
 * @param options - SDK configuration options
 * @returns The resolved remote config, or undefined if init failed gracefully
 */
export async function init(options: SDKInitOptions): Promise<Readonly<RemoteConfig> | undefined> {
  // Enable debug mode first so all init logging is visible if requested
  if (options.debug) {
    setDebugMode(true)
  }

  validateInitOptions(options)

  if (client.initialized) {
    if (!client.hasSameIdentity(options)) {
      throw new SDKError('SDK already initialized with different options', 'SDK_ALREADY_INITIALIZED')
    }
    return client.remoteConfig ?? undefined
  }

  const existingInit = client.getInitPromise()
  if (existingInit) {
    if (!client.hasSamePendingIdentity(options)) {
      throw new SDKError('SDK initialization already in progress with different options', 'SDK_INIT_IN_PROGRESS')
    }
    return existingInit
  }

  client.setPendingIdentity(options)
  const initPromise = initialize(options)
  client.setInitPromise(initPromise)

  try {
    return await initPromise
  } finally {
    client.clearPendingIdentity()
    client.setInitPromise(null)
  }
}

async function initialize(options: SDKInitOptions): Promise<Readonly<RemoteConfig> | undefined> {
  const logger = getLogger()
  const baseUrl = resolveBaseUrl(options.baseUrl)
  const endpoint = `${baseUrl.replace(/\/+$/, '')}/v1/init`

  client.setOptions(options)

  // Initialize breadcrumb buffer
  client.initBreadcrumbs(options.maxBreadcrumbs ?? 100)

  logger.info('SDK init started', {
    baseUrl,
    endpoint,
    service: options.service,
    environment: options.environment,
    release: options.release,
    debug: options.debug ?? false,
  })

  for (let attempt = 1; attempt <= INIT_MAX_ATTEMPTS; attempt += 1) {
    try {
      logger.debug('SDK init request sending', {
        endpoint,
        attempt,
        maxAttempts: INIT_MAX_ATTEMPTS,
      })

      const response = await sendInitRequest(
        options.apiKey,
        baseUrl,
        DEFAULT_TIMEOUT_MS,
      )

      if (response.success !== true) {
        throw new SDKError('Init response was not successful', 'INIT_REJECTED')
      }

      logger.debug('SDK init response received', {
        endpoint,
        attempt,
        projectId: response.projectId,
        hasConfig: isObject(response.config),
        hasIngestion: isObject(response.ingestion),
      })

      const remoteConfig = validateRemoteConfig(response)
      client.setRemoteConfig(remoteConfig)

      // Merge user options + remote config → ResolvedSDKConfig
      const resolvedConfig = mergeConfig(options, remoteConfig)
      client.setResolvedConfig(resolvedConfig)

      // Configure queue
      eventQueue.configure(resolvedConfig.maxQueueSize)
      filterBufferedEvents(resolvedConfig)

      logger.debug('SDK config resolved', {
        ingestUrl: resolvedConfig.ingestUrl,
        batchSize: resolvedConfig.batchSize,
        flushIntervalMs: resolvedConfig.flushIntervalMs,
        compression: resolvedConfig.compression,
        samplingRate: resolvedConfig.samplingRate,
      })

      // Initialize plugins
      if (options.plugins && options.plugins.length > 0) {
        await initializePlugins(options.plugins, resolvedConfig, client.metadata)
      }

      // Register user-provided event processors
      if (options.eventProcessors) {
        for (const processor of options.eventProcessors) {
          client.registerEventProcessor(processor)
        }
      }

      // Start subsystems
      startBatcher({
        batchSize: resolvedConfig.batchSize,
        flushIntervalMs: resolvedConfig.flushIntervalMs,
        logger,
        maxConcurrentSends: resolvedConfig.maxConcurrentSends,
      })
      setupGlobalErrorHandlers()
      registerSignalHandlers()

      logger.info('SDK initialized successfully', {
        service: resolvedConfig.service,
        environment: resolvedConfig.environment,
        release: resolvedConfig.release,
        pluginCount: client.plugins.length,
      })

      return remoteConfig
    } catch (error) {
      client.clearConfig()

      if (attempt >= INIT_MAX_ATTEMPTS) {
        client.clear()
        logger.error(
          'SDK initialization failed after retry budget exhausted; host application will continue without SDK telemetry',
          { error, endpoint, attempt, maxAttempts: INIT_MAX_ATTEMPTS }
        )
        return undefined
      }

      const nextRetryDelayMs = retryDelayMs(attempt)
      logger.warn('SDK init attempt failed; retrying', {
        error,
        endpoint,
        attempt,
        nextAttempt: attempt + 1,
        maxAttempts: INIT_MAX_ATTEMPTS,
        nextRetryDelayMs,
      })
      await sleep(nextRetryDelayMs)
    }
  }
}

// ─── Config Resolution ──────────────────────────────────────────────────────

function mergeConfig(options: SDKInitOptions, remote: RemoteConfig): ResolvedSDKConfig {
  return {
    apiKey: options.apiKey,
    service: options.service ?? 'unknown-service',
    environment: options.environment ?? 'production',
    release: options.release ?? '0.0.0-unknown',
    debug: options.debug ?? false,

    enableErrors: options.enableErrors ?? remote.enableErrors,
    enablePerformance: options.enablePerformance ?? remote.enablePerformance,
    enableTracing: options.enableTracing ?? false,
    enableMetrics: options.enableMetrics ?? false,

    samplingRate: options.sampleRate ?? remote.samplingRate,

    maxBreadcrumbs: options.maxBreadcrumbs ?? 100,
    maxQueueSize: remote.maxQueueSize,
    shutdownTimeoutMs: options.shutdownTimeoutMs ?? 10_000,

    ingestUrl: remote.ingestUrl,
    batchSize: options.transport?.batchSize ?? remote.batchSize,
    flushIntervalMs: options.transport?.flushIntervalMs ?? remote.flushIntervalMs,
    maxRetries: options.transport?.maxRetries ?? remote.maxRetries,
    timeoutMs: options.transport?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    compression: options.transport?.compression ?? 'gzip',
    maxPayloadBytes: options.transport?.maxPayloadBytes ?? remote.maxPayloadBytes,
    maxConcurrentSends: options.transport?.maxConcurrentSends ?? 3,
  }
}

// ─── Validation ─────────────────────────────────────────────────────────────

function validateInitOptions(options: SDKInitOptions): void {
  const result = sdkInitOptionsSchema.safeParse(options)

  if (!result.success) {
    const issues = result.error.issues.map(
      issue => `${issue.path.join('.')}: ${issue.message}`
    )
    throw new SDKError(
      `Invalid SDK init options: ${issues.join('; ')}`,
      'INVALID_INIT_OPTIONS',
      { issues }
    )
  }
}

function resolveBaseUrl(userBaseUrl?: string): string {
  const baseUrl = userBaseUrl ?? DEFAULT_BASE_URL
  if (!baseUrl) {
    throw new SDKError('SDK_BASE_URL is required', 'MISSING_BASE_URL')
  }
  validateUrl(baseUrl, 'baseUrl')
  return baseUrl
}

function validateRemoteConfig(response: InitResponse): RemoteConfig {
  const config = isObject(response.config) ? response.config : null
  const ingestion = isObject(response.ingestion) ? response.ingestion : null

  if (!config) {
    throw new SDKError('Init config is missing or invalid', 'INVALID_INIT_CONFIG')
  }

  const ingestUrl = stringField(config, ['ingestUrl', 'ingestURL', 'apiEndpoint'])
    ?? stringField(ingestion, ['endpoint', 'ingestUrl', 'apiEndpoint'])

  if (!ingestUrl) {
    throw new SDKError('Init config missing ingestUrl', 'INVALID_INIT_CONFIG')
  }

  validateUrl(ingestUrl, 'ingestUrl')

  return {
    ingestUrl,
    samplingRate: requiredNumberField(config['samplingRate'], 'samplingRate', 0, 1),
    enableErrors: requiredBooleanField(config['enableErrors'], 'enableErrors'),
    enablePerformance: requiredBooleanField(config['enablePerformance'], 'enablePerformance'),
    maxQueueSize: requiredIntField(
      ingestion?.['maxQueueSize'] ?? ingestion?.['queueSizeLimit'],
      'maxQueueSize',
      1
    ),
    batchSize: requiredIntField(ingestion?.['batchSize'], 'batchSize', 1),
    flushIntervalMs: requiredIntField(
      ingestion?.['flushInterval'] ?? ingestion?.['flushIntervalMs'],
      'flushIntervalMs',
      1
    ),
    maxRetries: optionalIntField(config['maxRetries'], 'maxRetries', DEFAULT_MAX_RETRIES, 0),
    maxPayloadBytes: optionalIntField(config['maxPayloadBytes'], 'maxPayloadBytes', DEFAULT_MAX_PAYLOAD_BYTES, 1),
  }
}

function filterBufferedEvents(config: ResolvedSDKConfig): void {
  eventQueue.filter(event => {
    const e = event as Record<string, unknown>
    if (e['type'] === 'request') {
      return config.enablePerformance && Math.random() <= config.samplingRate
    }
    if (e['type'] === 'error') {
      return config.enableErrors
    }
    return true
  })
}

// ─── Field Extractors ───────────────────────────────────────────────────────

function stringField(raw: Record<string, unknown> | null, names: string[]): string | null {
  if (!raw) return null
  for (const name of names) {
    const value = raw[name]
    if (typeof value === 'string' && value.trim()) return value
  }
  return null
}

function requiredBooleanField(value: unknown, fieldName: string): boolean {
  if (typeof value !== 'boolean') {
    throw new SDKError(`Init config field ${fieldName} must be boolean`, 'INVALID_INIT_CONFIG', { fieldName })
  }
  return value
}

function requiredNumberField(value: unknown, fieldName: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new SDKError(`Init config field ${fieldName} out of range`, 'INVALID_INIT_CONFIG', {
      fieldName, min, max, value,
    })
  }
  return value
}

function requiredIntField(value: unknown, fieldName: string, min: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value < min) {
    throw new SDKError(`Init config field ${fieldName} must be an integer >= ${min}`, 'INVALID_INIT_CONFIG', {
      fieldName, min, value,
    })
  }
  return value
}

function optionalIntField(value: unknown, fieldName: string, fallback: number, min: number): number {
  if (value === undefined || value === null) return fallback
  return requiredIntField(value, fieldName, min)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object'
}

function validateUrl(value: string, fieldName: string): void {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('Unsupported protocol')
    }
  } catch (error) {
    throw new SDKError(`${fieldName} must be a valid HTTP URL`, 'INVALID_URL', { fieldName }, error)
  }
}

function retryDelayMs(attempt: number): number {
  const exponential = Math.min(INIT_MAX_RETRY_DELAY_MS, INIT_BASE_RETRY_DELAY_MS * 2 ** (attempt - 1))
  return Math.floor(exponential / 2 + Math.random() * (exponential / 2))
}
