/**
 * Unified TransportRouter.
 *
 * One singleton owns outbound telemetry delivery for the SDK lifecycle:
 * event classification, bounded queues, adaptive batchers, route health,
 * and one shared connection manager with global and per-route limits.
 */
import type { ConfigDiff, RemoteConfigResponse, TransportRemoteConfig } from '../types/config.js';
import type { SDKEvent } from '../types/event.js';
import type { MultiRouteTransportHealth } from '../types/transport.js';
import { type EnterpriseRoute } from './route-registry.js';
import { type QueueDropInfo } from './transport-event-queue.js';
export declare class TransportRouter {
    private transportConfig;
    private readonly apiKey;
    private readonly fetchImpl;
    private static instance;
    private registry;
    private connectionManager;
    private healthMonitor;
    private batchManagers;
    private queues;
    private disabled;
    private destroyed;
    private readonly dropped;
    private dropLogCount;
    private multiplexed;
    private useMultiplexedTransport;
    private constructor();
    /**
     * Initialize the singleton transport router.
     *
     * If a previous instance exists, this method awaits its shutdown before
     * installing the new instance. This prevents a stale BatchManager from
     * sending events through an out-of-date connection manager during a warm
     * reinit.
     *
     * NOTE: This method is async because shutdown drains in-flight batches.
     * Callers must await the returned promise before sending events.
     */
    static initialize(config: TransportRemoteConfig, apiKey: string, fetchImpl?: typeof fetch, useMultiplexedTransport?: boolean): Promise<TransportRouter>;
    static getInstance(): TransportRouter | null;
    send(event: SDKEvent): boolean;
    sendBatch(events: readonly SDKEvent[]): void;
    disable(): void;
    enable(): void;
    isDisabled(): boolean;
    handleConfigChange(_diff: ConfigDiff, newConfig: Readonly<RemoteConfigResponse>): void;
    /**
     * Hot-swap the transport configuration: rebuild the route registry,
     * connection manager, queues and batchers, then re-enqueue everything
     * that was waiting so no event is lost across the swap.
     */
    updateTransport(transport: TransportRemoteConfig): void;
    getHealth(): MultiRouteTransportHealth;
    getDebugState(): {
        inFlightSends: Readonly<Record<EnterpriseRoute, number>>;
        queuedEvents: Readonly<Record<EnterpriseRoute, number>>;
        batchedEvents: Readonly<Record<EnterpriseRoute, number>>;
        droppedEvents: readonly QueueDropInfo[];
    };
    flushAll(): Promise<void>;
    /**
     * Drain every per-route queue and return the residual events.
     *
     * Called from the shutdown lifecycle AFTER `flushAll()` has done its best
     * to deliver everything via the network. Anything still in the queues at
     * this point is undelivered and would otherwise be lost when the process
     * exits — the lifecycle layer pipes these into `persistentStorage` so they
     * are replayed on the next start.
     *
     * Returns events in arbitrary route order. The caller is responsible for
     * persisting them; this method does not touch the filesystem itself so
     * tests can run without it.
     */
    drainAllQueues(): SDKEvent[];
    shutdown(): Promise<void>;
    static reset(): Promise<void>;
    private createQueuesAndBatchers;
    private createConnectionManager;
    private routeHealth;
    private recordDrop;
}
//# sourceMappingURL=transport-router.d.ts.map