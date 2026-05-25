import type { SDKEvent } from '../types/event.js';
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
    readonly totalRequests: number;
    readonly avgBatchSize: number;
}
export declare class BatchManager {
    private readonly options;
    private timer;
    private activeSends;
    private batched;
    private totalSent;
    private totalDropped;
    private totalFailed;
    private totalRequests;
    private totalBatchEvents;
    private destroyed;
    private firstQueuedAt;
    private readonly fetchImpl;
    constructor(options: BatchManagerOptions);
    enqueue(event: SDKEvent): boolean;
    /**
     * Drain the queue. Bounded so a permanently-unreachable endpoint cannot
     * keep flush() spinning forever — re-queued failures eventually exhaust
     * the retry budget and the residual events are surrendered to the queue
     * for the upstream lifecycle/persistence layer to handle.
     */
    flush(): Promise<void>;
    shutdown(): Promise<void>;
    stats(): BatchManagerStats;
    private pump;
    private nextSerializableBatch;
    private sendBatch;
    private effectiveMaxBatchSize;
    private effectiveConcurrency;
    private maxWaitElapsed;
    private effectiveMaxWaitMs;
    private ensureTimer;
    private clearTimer;
    /**
     * Compute the JSON-encoded payload size for a batch.
     *
     * Returns a negative sentinel (-1) on serialization failure so callers can
     * distinguish "payload too large" from "payload not serializable" and
     * avoid re-serializing the same bad batch (which would double-count the
     * dropped events in stats).
     *
     * On serialization failure we drop the entire batch in one go and emit
     * a single onDrop notification with reason='serialization_failed'.
     */
    private byteLength;
}
//# sourceMappingURL=batch-manager.d.ts.map