import { DEFAULT_TIMEOUT_MS } from '../constants/defaults.js'
import { randomUUID } from 'crypto'
import { client } from '../core/client.js'
import { SDKError } from '../core/errors.js'
import { postJson } from './http.js'
import { retry, globalRetryBudget } from './retry.js'
import type { ResolvedSDKConfig } from '../types/config.js'
import type { Event } from '../types/event.js'
import { getLogger } from '../utils/logger.js'

export interface InitResponse {
    success: boolean
    projectId?: string
    plan?: string
    planFeatures?: Record<string, unknown>
    config?: unknown
    ingestion?: unknown
}

export async function sendInitRequest(apiKey: string, baseUrl: string, timeoutMs = 5000) {
    validateApiKey(apiKey)

    if (!baseUrl) {
        throw new SDKError('baseUrl is required for init request', 'MISSING_BASE_URL')
    }

    return postJson<InitResponse>(joinUrl(baseUrl, '/v1/init'), { apiKey }, {}, timeoutMs, { logFailures: false })
}

export async function sendEvents(events: Event[]) {
    if (events.length === 0) return

    const logger = getLogger()
    const config: Readonly<ResolvedSDKConfig> = client.config
    const apiKey = client.getApiKey()
    const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
    let sentPayloads = 0

    for (const payload of createPayloads(events.map(ensureEventId), apiKey, config.maxPayloadBytes)) {
        try {
            logger.debug('Ingest payload send started', {
                event: 'INGEST_PAYLOAD_SEND_STARTED',
                endpoint: config.ingestUrl,
                eventCount: payload.events.length,
                payloadIndex: sentPayloads + 1,
                timeoutMs,
            })

            await retry(() => postJson<unknown>(config.ingestUrl, payload, {}, timeoutMs, { logFailures: false, compression: config.compression }), {
                retries: config.maxRetries,
                retryable: isRetryable,
                budget: globalRetryBudget,
                onRetry: ({ error, attempt, nextAttempt, maxAttempts, nextRetryDelayMs }) => {
                    if (attempt === 1 || nextAttempt === maxAttempts) {
                        logger.warn('Ingest payload send failed; retrying', {
                            event: 'INGEST_SEND_RETRY',
                            error,
                            endpoint: config.ingestUrl,
                            attempt,
                            nextAttempt,
                            maxAttempts,
                            nextRetryDelayMs,
                            eventCount: payload.events.length,
                            payloadIndex: sentPayloads + 1,
                            retryBudget: globalRetryBudget.getState(),
                        })
                    }
                },
            })
            sentPayloads += 1
            logger.info('Ingest payload sent', {
                event: 'INGEST_PAYLOAD_SENT',
                endpoint: config.ingestUrl,
                eventCount: payload.events.length,
                payloadIndex: sentPayloads,
            })
        } catch (error) {
            logger.error('Ingest payload send failed', {
                event: 'INGEST_SEND_FAILED',
                error,
                endpoint: config.ingestUrl,
                sentPayloads,
                failedPayloadEventCount: payload.events.length,
                totalEventCount: events.length,
            })
            throw new SDKError(
                'Failed to send ingest payload',
                'INGEST_SEND_FAILED',
                {
                    sentPayloads,
                    failedPayloadEventCount: payload.events.length,
                    totalEventCount: events.length
                },
                error
            )
        }
    }
}

function ensureEventId(event: Event): Event {
    if (event.eventId !== undefined) {
        if (typeof event.eventId !== 'string' || event.eventId.trim().length === 0) {
            throw new SDKError('eventId must be a non-empty string', 'INVALID_EVENT_ID')
        }

        return event
    }

    return {
        ...event,
        eventId: randomUUID()
    }
}

function isRetryable(error: Error) {
    if (!(error instanceof SDKError)) return false
    if (error.code === 'NETWORK_ERROR') return true

    const status = Number(error.context.statusCode ?? error.context.status)
    return status === 408 || status === 429 || status >= 500
}

/**
 * Split events into payload chunks that fit within maxPayloadBytes.
 *
 * Uses incremental byte tracking — O(n) instead of re-serializing the
 * entire growing batch on every event (which was O(n²)).
 */
function createPayloads(events: Event[], apiKey: string, maxPayloadBytes: number) {
    if (!Number.isInteger(maxPayloadBytes) || maxPayloadBytes <= 0) {
        throw new SDKError('maxPayloadBytes must be a positive integer', 'INVALID_MAX_PAYLOAD_BYTES', {
            maxPayloadBytes
        })
    }

    // Pre-compute the wrapper overhead: {"apiKey":"...","events":[]}
    const wrapperOverhead = safeJsonByteLength(createIngestPayload(apiKey, []), { maxPayloadBytes })

    const payloads: Array<{ apiKey: string, events: Event[] }> = []
    let current: Event[] = []
    let currentBatchBytes = wrapperOverhead

    for (const event of events) {
        const eventBytes = safeJsonByteLength(event, { maxPayloadBytes })
        // Account for JSON array separator (comma between events)
        const separatorBytes = current.length > 0 ? 1 : 0

        // Guard: single event exceeds max
        if (wrapperOverhead + eventBytes > maxPayloadBytes) {
            throw new SDKError('Single event exceeds configured payload maximum', 'EVENT_TOO_LARGE', {
                payloadBytes: wrapperOverhead + eventBytes,
                maxPayloadBytes
            })
        }

        const candidateBytes = currentBatchBytes + eventBytes + separatorBytes

        if (current.length > 0 && candidateBytes > maxPayloadBytes) {
            payloads.push(createIngestPayload(apiKey, current))
            current = [event]
            currentBatchBytes = wrapperOverhead + eventBytes
        } else {
            current.push(event)
            currentBatchBytes = candidateBytes
        }
    }

    if (current.length > 0) {
        payloads.push(createIngestPayload(apiKey, current))
    }

    return payloads
}

function createIngestPayload(apiKey: string, events: Event[]) {
    return {
        apiKey,
        events
    }
}

function validateApiKey(apiKey: string) {
    if (typeof apiKey !== 'string' || apiKey.trim().length === 0) {
        throw new SDKError('apiKey is required', 'INVALID_API_KEY')
    }
}

function joinUrl(baseUrl: string, path: string) {
    return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
}

function safeJsonByteLength(value: unknown, context: Record<string, unknown>) {
    try {
        return Buffer.byteLength(JSON.stringify(value))
    } catch (error) {
        throw new SDKError('Payload is not JSON serializable', 'PAYLOAD_SERIALIZATION_FAILED', context, error)
    }
}
