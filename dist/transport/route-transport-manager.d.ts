/**
 * RouteTransportManager — manages a single transport route (e.g., 'errors', 'traces').
 *
 * Each route has its own:
 * - Batching buffer with configurable batchSize and flushIntervalMs
 * - Queue with maxSize and overflow strategy (drop_oldest)
 * - Retry logic with exponential backoff
 * - Independent failure domain (one route failing doesn't affect others)
 * - Per-route compression setting
 * - Per-route priority and timeout
 */
import type { TransportEndpointConfig, TransportRouteName, TransportSharedConfig } from '../types/config.js';
import type { RouteTransportHealth } from '../types/transport.js';
import type { SDKEvent } from '../types/event.js';
export declare class RouteTransportManager {
    readonly route: TransportRouteName;
    private endpointConfig;
    private sharedConfig;
    private apiKey;
    private buffer;
    private flushTimer;
    private queue;
    private totalSent;
    private totalFailed;
    private totalDropped;
    private totalRetries;
    private lastSendAt;
    private lastErrorAt;
    private latencies;
    private circuitState;
    private consecutiveFailures;
    private circuitOpenUntil;
    private static readonly CIRCUIT_FAILURE_THRESHOLD;
    private static readonly CIRCUIT_RESET_MS;
    private inFlight;
    private destroyed;
    private sending;
    constructor(route: TransportRouteName, endpointConfig: TransportEndpointConfig, sharedConfig: TransportSharedConfig, apiKey: string);
    /** Start the flush timer. */
    start(): void;
    /** Enqueue an event for batched sending. */
    enqueue(event: SDKEvent): void;
    /** Flush the current buffer to the send queue. */
    flush(): Promise<void>;
    /** Process queued batches. */
    private processQueue;
    /** Send a batch to the endpoint with retry logic. */
    private sendBatch;
    /** Update endpoint config on config change. */
    updateConfig(endpointConfig: TransportEndpointConfig, sharedConfig: TransportSharedConfig): void;
    /** Get route health status. */
    getHealth(): RouteTransportHealth;
    /** Flush all pending events and stop. */
    shutdown(): Promise<void>;
    private stopFlushTimer;
    private getBackoffMs;
    private trackLatency;
    private sleep;
}
//# sourceMappingURL=route-transport-manager.d.ts.map