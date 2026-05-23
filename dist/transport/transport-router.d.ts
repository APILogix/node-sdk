/**
 * TransportRouter — routes events to the correct transport based on event type.
 *
 * Architecture:
 * - 8 independent RouteTransportManager instances (traces, errors, logs, metrics,
 *   profiles, replays, crons, envelope).
 * - Each route has its own batching, queue, retry, and circuit breaker.
 * - Events are routed by type → route mapping.
 * - Killswitch: disableTransport → stops ALL routes immediately.
 * - Config change: Updates individual route configs without restarting others.
 */
import type { TransportRemoteConfig, ConfigDiff, RemoteConfigResponse } from '../types/config.js';
import type { MultiRouteTransportHealth } from '../types/transport.js';
import type { SDKEvent } from '../types/event.js';
export declare class TransportRouter {
    private static instance;
    private routes;
    private transportConfig;
    private apiKey;
    private disabled;
    private destroyed;
    private constructor();
    static initialize(config: TransportRemoteConfig, apiKey: string): TransportRouter;
    static getInstance(): TransportRouter | null;
    /**
     * Route an event to the appropriate transport.
     * Never throws — drops silently if disabled or route not found.
     */
    send(event: SDKEvent): void;
    /**
     * Send multiple events at once.
     */
    sendBatch(events: readonly SDKEvent[]): void;
    /** Disable all transport (killswitch). */
    disable(): void;
    /** Re-enable transport (killswitch deactivated). */
    enable(): void;
    /** Check if transport is disabled. */
    isDisabled(): boolean;
    /** Handle config change — update individual route configs. */
    handleConfigChange(_diff: ConfigDiff, newConfig: Readonly<RemoteConfigResponse>): void;
    /** Get aggregate health across all routes. */
    getHealth(): MultiRouteTransportHealth;
    /** Flush all routes. */
    flushAll(): Promise<void>;
    /** Graceful shutdown — flush all routes and stop. */
    shutdown(): Promise<void>;
    private createRoutes;
    static reset(): void;
}
//# sourceMappingURL=transport-router.d.ts.map