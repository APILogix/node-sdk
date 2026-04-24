import type { SDKInitOptions } from '../types/config.js'
import { client } from './client.js'
import type { InitResponse } from '../transport/sender.js'
import { sendInitRequest } from '../transport/sender.js'
import { setRemoteConfig } from './config.js'
import { startBatcher } from '../transport/batcher.js'
import { setupGlobalErrorHandlers } from '../instrumentation/global-errors.js'
import { eventQueue } from '../transport/queue.js'
import { DEFAULT_BASE_URL, DEFAULT_MAX_PAYLOAD_BYTES, DEFAULT_MAX_RETRIES, DEFAULT_TIMEOUT_MS } from '../constants/defaults.js'
import type { RemoteConfig } from '../types/config.js'
import { SDKError } from './errors.js'
import { getLogger } from '../utils/logger.js'

export async function init(options: SDKInitOptions): Promise<Readonly<RemoteConfig>> {
    validateInitOptions(options)

    if (client.initialized) {
        if (!client.hasSameIdentity(options)) {
            throw new SDKError('SDK already initialized with different options', 'SDK_ALREADY_INITIALIZED')
        }

        return client.config
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

async function initialize(options: SDKInitOptions): Promise<Readonly<RemoteConfig>> {
    const logger = getLogger()
    const baseUrl = resolveBaseUrl()

    client.setOptions(options)
    logger.info('SDK init started', {
        baseUrl,
    })

    try {
        logger.info('SDK init request sending', {
            endpoint: `${baseUrl.replace(/\/+$/, '')}/v1/init`,
        })

        const response = await sendInitRequest(
            options.apiKey,
            baseUrl,
            DEFAULT_TIMEOUT_MS,
        )

        if (response.success !== true) {
            throw new SDKError('Init response was not successful', 'INIT_REJECTED')
        }

        logger.info('SDK init response received', {
            projectId: response.projectId,
            hasConfig: isObject(response.config),
            hasIngestion: isObject(response.ingestion),
        })

        const config = validateRemoteConfig(response)
        setRemoteConfig(config)
        eventQueue.configure(config.maxQueueSize)
        filterBufferedEvents(config)

        logger.info('SDK init config normalized', {
            ingestUrl: config.ingestUrl,
            batchSize: config.batchSize,
            flushIntervalMs: config.flushIntervalMs,
            maxQueueSize: config.maxQueueSize,
        })

        startBatcher({
            batchSize: config.batchSize,
            flushIntervalMs: config.flushIntervalMs,
            logger,
        })
        setupGlobalErrorHandlers()

        logger.info('SDK init completed', {
            ingestUrl: config.ingestUrl,
            batchSize: config.batchSize,
            flushIntervalMs: config.flushIntervalMs,
            maxQueueSize: config.maxQueueSize,
            maxPayloadBytes: config.maxPayloadBytes,
        })

        return client.config
    } catch (error) {
        client.clear()
        logger.error('SDK initialization failed', { error })
        throw error
    }
}

function validateInitOptions(options: SDKInitOptions) {
    if (!options || typeof options !== 'object') {
        throw new SDKError('Init options are required', 'INVALID_INIT_OPTIONS')
    }

    if (typeof options.apiKey !== 'string' || options.apiKey.trim().length === 0) {
        throw new SDKError('apiKey is required', 'INVALID_API_KEY')
    }
}

function resolveBaseUrl() {
    const baseUrl = DEFAULT_BASE_URL
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
        samplingRate: requiredNumberField(config.samplingRate, 'samplingRate', 0, 1),
        enableErrors: requiredBooleanField(config.enableErrors, 'enableErrors'),
        enablePerformance: requiredBooleanField(config.enablePerformance, 'enablePerformance'),
        maxQueueSize: requiredIntField(
            ingestion?.maxQueueSize ?? ingestion?.queueSizeLimit,
            'maxQueueSize',
            1
        ),
        batchSize: requiredIntField(ingestion?.batchSize, 'batchSize', 1),
        flushIntervalMs: requiredIntField(ingestion?.flushInterval ?? ingestion?.flushIntervalMs, 'flushIntervalMs', 1),
        maxRetries: optionalIntField(config.maxRetries, 'maxRetries', DEFAULT_MAX_RETRIES, 0),
        maxPayloadBytes: optionalIntField(config.maxPayloadBytes, 'maxPayloadBytes', DEFAULT_MAX_PAYLOAD_BYTES, 1),
    }
}

function filterBufferedEvents(config: RemoteConfig) {
    eventQueue.filter(event => {
        if (event.type === 'request') {
            return config.enablePerformance && Math.random() <= config.samplingRate
        }

        if (event.type === 'error') {
            return config.enableErrors
        }

        return true
    })
}

function stringField(raw: Record<string, unknown> | null, names: string[]) {
    if (!raw) {
        return null
    }

    for (const name of names) {
        const value = raw[name]
        if (typeof value === 'string' && value.trim()) {
            return value
        }
    }

    return null
}

function requiredBooleanField(value: unknown, fieldName: string) {
    if (typeof value !== 'boolean') {
        throw new SDKError(`Init config field ${fieldName} must be boolean`, 'INVALID_INIT_CONFIG', { fieldName })
    }

    return value
}

function requiredNumberField(value: unknown, fieldName: string, min: number, max: number) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
        throw new SDKError(`Init config field ${fieldName} out of range`, 'INVALID_INIT_CONFIG', {
            fieldName,
            min,
            max,
            value,
        })
    }

    return value
}

function requiredIntField(value: unknown, fieldName: string, min: number) {
    if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value < min) {
        throw new SDKError(`Init config field ${fieldName} must be an integer >= ${min}`, 'INVALID_INIT_CONFIG', {
            fieldName,
            min,
            value,
        })
    }

    return value
}

function optionalIntField(value: unknown, fieldName: string, fallback: number, min: number) {
    if (value === undefined || value === null) {
        return fallback
    }

    return requiredIntField(value, fieldName, min)
}

function isObject(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object'
}

function validateUrl(value: string, fieldName: string) {
    try {
        const url = new URL(value)
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
            throw new Error('Unsupported protocol')
        }
    } catch (error) {
        throw new SDKError(`${fieldName} must be a valid HTTP URL`, 'INVALID_URL', { fieldName }, error)
    }
}
