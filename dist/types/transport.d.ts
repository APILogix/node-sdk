/**
 * Transport-related types for HTTP communication and ingestion.
 */
import type { Event } from './event.js';
import type { TransportRouteName } from './config.js';
/**
 * Result of an HTTP transport call.
 */
export interface TransportResult {
    readonly success: boolean;
    readonly statusCode: number;
    readonly body?: unknown;
    readonly retryAfterMs?: number;
    readonly rateLimitRemaining?: number;
    readonly requestId?: string;
    readonly durationMs: number;
}
/**
 * Payload sent to the ingestion endpoint.
 */
export interface IngestPayload {
    readonly apiKey: string;
    readonly events: readonly Event[];
}
/**
 * Transport health status for observability.
 */
export interface TransportHealth {
    readonly circuitState: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
    readonly rateLimitRemaining: number;
    readonly inFlightCount: number;
    readonly totalSent: number;
    readonly totalFailed: number;
    readonly totalDropped: number;
    readonly queueSize: number;
    readonly deadLetterCount: number;
}
/**
 * Configuration for a custom transport implementation.
 */
export interface TransportAdapter {
    /** Send a payload to the ingestion endpoint. */
    send(payload: IngestPayload): Promise<TransportResult>;
    /** Flush any pending payloads. */
    flush(): Promise<void>;
    /** Shut down the transport gracefully. */
    shutdown(): Promise<void>;
}
/** Per-route transport health status for the multi-route transport layer. */
export interface RouteTransportHealth {
    readonly route: TransportRouteName;
    readonly url: string;
    readonly priority: string;
    readonly queueSize: number;
    readonly queueCapacity: number;
    readonly inFlightCount: number;
    readonly totalSent: number;
    readonly totalFailed: number;
    readonly totalDropped: number;
    readonly totalRetries: number;
    readonly circuitState: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
    readonly lastSendAt: number | null;
    readonly lastErrorAt: number | null;
    readonly avgLatencyMs: number;
}
/** Aggregate transport health across all routes. */
export interface MultiRouteTransportHealth {
    readonly routes: Readonly<Record<string, RouteTransportHealth>>;
    readonly globalConnectionCount: number;
    readonly maxGlobalConnections: number;
    readonly transportDisabled: boolean;
}
//# sourceMappingURL=transport.d.ts.map