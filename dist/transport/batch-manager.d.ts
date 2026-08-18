import type { SDKEvent } from '../types/event.js';
import type { TransportRetryConfig } from '../types/config.js';
import { TransportEventQueue, type QueueDropInfo } from './transport-event-queue.js';
import { ConnectionManager } from './connection-manager.js';
import { HealthMonitor } from './health-monitor.js';
import type { EnterpriseRoute, RouteDefinition } from './route-registry.js';
export interface BatchManagerOptions {
    readonly route: EnterpriseRoute;
    readonly definition: RouteDefinition;
    readonly apiKey: string;
    readonly queue: TransportEventQueue;
    readonly connectionManager: ConnectionManager;
    readonly healthMonitor: HealthMonitor;
    readonly maxBatchSize: number;
    readonly minBatchSize: number;
    readonly maxWaitTimeMs: number;
    readonly maxPayloadBytes: number;
    readonly socketTimeoutMs: number;
    /** Retained for config compatibility; telemetry batches are always sent gzip-compressed. */
    readonly compression: 'gzip' | 'none';
    readonly keepAlive: boolean;
    readonly retry: TransportRetryConfig;
    readonly onDrop?: (info: QueueDropInfo) => void;
    readonly fetchImpl?: typeof fetch;
}
export interface BatchManagerStats {
    readonly route: EnterpriseRoute;
    readonly queuedEvents: number;
    readonly batchedEvents: number;
    readonly inFlightSends: number;
    readonly totalSent: number;
    readonly totalDropped: number;
    readonly totalFailed: number;
    readonly totalRetries: number;
    readonly totalRequests: number;
    readonly avgBatchSize: number;
}
export declare class BatchManager {
    private readonly options;
    private timer;
    private activeSends;
    private readonly activeSendPromises;
    private readonly activeBatches;
    private readonly activeAbortControllers;
    private readonly handedOffEvents;
    private readonly pendingRetryPromises;
    private readonly pendingRetryTimers;
    private readonly retryAttempts;
    private batched;
    private totalSent;
    private totalDropped;
    private totalFailed;
    private totalRetries;
    private totalRequests;
    private totalBatchEvents;
    private destroyed;
    private firstQueuedAt;
    private readonly fetchImpl;
    constructor(options: BatchManagerOptions);
    enqueue(event: SDKEvent): boolean;
    /** Drain without event-loop polling; waits only on tracked work promises. */
    flush(): Promise<void>;
    /**
     * Stop new work, cancel delayed retries, abort active requests, and return
     * any batches that could not be quiesced within the bounded wait. The
     * router persists returned events before dropping manager references.
     */
    shutdown(timeoutMs?: number): Promise<SDKEvent[]>;
    stats(): BatchManagerStats;
    private pump;
    private nextSerializableBatch;
    private sendBatch;
    private retryOrRetain;
    private cancelPendingRetries;
    /**
     * Persist a batch to disk after a transient send failure.
     *
     * Called on network errors, retry-eligible HTTP failures (5xx, 429, 408),
     * and connection-acquisition starvation. NOT called on 4xx permanent
     * rejections — those are dropped because replaying them forever is a bug.
     *
     * Persistence is best-effort and never throws to the caller. The batch
     * is still re-queued in memory by the caller; persistence is purely
     * defense against process crash before the in-memory retry succeeds.
     */
    private persistOnFailure;
    /**
     * Discard delivered events from durable storage after backend ACK.
     *
     * Fire-and-forget: the rewrite is serialized through the storage write
     * chain, so completion order is correct, but we do not await here so a
     * slow filesystem cannot block the send pipeline. A crash before the
     * discard write hits disk leaves the events on disk and produces a
     * single duplicate replay on the next start — which the backend MUST
     * dedupe by `eventId` per the at-least-once delivery contract.
     */
    private discardOnSuccess;
    private effectiveMaxBatchSize;
    private effectiveConcurrency;
    private maxWaitElapsed;
    private effectiveMaxWaitMs;
    private ensureTimer;
    private clearTimer;
}
//# sourceMappingURL=batch-manager.d.ts.map