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
    private readonly firstAttemptTimestamps;
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
     * any batches that could not be quiesced within the bounded wait.
     */
    shutdown(timeoutMs?: number): Promise<SDKEvent[]>;
    stats(): BatchManagerStats;
    private pump;
    private nextSerializableBatch;
    private sendBatch;
    private retryOrRetain;
    private cancelPendingRetries;
    private persistOnFailure;
    private discardOnSuccess;
    private effectiveMaxBatchSize;
    private effectiveConcurrency;
    private maxWaitElapsed;
    private effectiveMaxWaitMs;
    private ensureTimer;
    private clearTimer;
}
