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
    getHealth(): MultiRouteTransportHealth;
    getDebugState(): {
        inFlightSends: Readonly<Record<EnterpriseRoute, number>>;
        queuedEvents: Readonly<Record<EnterpriseRoute, number>>;
        batchedEvents: Readonly<Record<EnterpriseRoute, number>>;
        droppedEvents: readonly QueueDropInfo[];
    };
    flushAll(): Promise<void>;
    shutdown(): Promise<void>;
    static reset(): Promise<void>;
    private createQueuesAndBatchers;
    private createConnectionManager;
    private routeHealth;
    private recordDrop;
}
//# sourceMappingURL=transport-router.d.ts.map