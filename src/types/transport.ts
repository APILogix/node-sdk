/**
 * Transport-related types for HTTP communication and ingestion.
 */

import type { Event } from './event.js'

/**
 * Result of an HTTP transport call.
 */
export interface TransportResult {
  readonly success: boolean
  readonly statusCode: number
  readonly body?: unknown
  readonly retryAfterMs?: number
  readonly rateLimitRemaining?: number
  readonly requestId?: string
  readonly durationMs: number
}

/**
 * Payload sent to the ingestion endpoint.
 */
export interface IngestPayload {
  readonly apiKey: string
  readonly events: readonly Event[]
}

/**
 * Transport health status for observability.
 */
export interface TransportHealth {
  readonly circuitState: 'CLOSED' | 'OPEN' | 'HALF_OPEN'
  readonly rateLimitRemaining: number
  readonly inFlightCount: number
  readonly totalSent: number
  readonly totalFailed: number
  readonly totalDropped: number
  readonly queueSize: number
  readonly deadLetterCount: number
}

/**
 * Configuration for a custom transport implementation.
 */
export interface TransportAdapter {
  /** Send a payload to the ingestion endpoint. */
  send(payload: IngestPayload): Promise<TransportResult>
  /** Flush any pending payloads. */
  flush(): Promise<void>
  /** Shut down the transport gracefully. */
  shutdown(): Promise<void>
}
