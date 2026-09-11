import type { RemoteConfigResponse } from '../types/config.js';
import type { ConfigApplier } from './config-applier.js';
import type { RemoteConfigClient } from './remote-config-client.js';
export declare enum ConfigState {
    Pending = "pending",
    Live = "live"
}
/**
 * Single source of truth for remote SDK configuration.
 *
 * There is no fallback config, merge layer, local override, polling timer, or
 * retry loop. A validated immutable snapshot is installed from /v1/init and
 * atomically replaced only after a telemetry response asks for a refresh.
 */
export declare class ConfigManager {
    private static instance;
    private currentConfig;
    private currentHash;
    private remoteClient;
    private applier;
    private refreshPromise;
    private destroyed;
    private state;
    private constructor();
    static getInstance(): ConfigManager;
    /** Return the live instance without creating one. */
    static getCurrent(): ConfigManager | null;
    /** Install the complete /v1/init snapshot. */
    initialize(remoteClient: RemoteConfigClient, payload: unknown): Readonly<RemoteConfigResponse>;
    setApplier(applier: ConfigApplier): void;
    getConfig(): Readonly<RemoteConfigResponse>;
    getConfigOrNull(): Readonly<RemoteConfigResponse> | null;
    getState(): ConfigState;
    isLive(): boolean;
    isDestroyed(): boolean;
    isRefreshInFlight(): boolean;
    /**
     * Inspect a parsed telemetry acknowledgement. Only a 202/change:true signal
     * is actionable. Additional signals are intentionally ignored while the
     * single refresh is in flight.
     */
    handleTelemetryResponse(httpStatus: number, payload: unknown): void;
    /** Test/lifecycle barrier; does not initiate network activity. */
    waitForRefresh(): Promise<void>;
    destroy(): void;
    static reset(): void;
    private refreshOnce;
}
/** Inspect a fetch Response without delaying telemetry acknowledgement work. */
export declare function inspectTelemetryResponse(response: Response): void;
/** Inspect an already parsed response (used by the shared JSON transport). */
export declare function inspectTelemetryPayload(httpStatus: number, payload: unknown): void;
