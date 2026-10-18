import type { SDKEvent } from '../types/event.js';
import type { TransportRemoteConfig } from '../types/config.js';
export type EnterpriseRoute = 'errors' | 'events' | 'traces' | 'spans' | 'metrics' | 'logs' | 'profiles' | 'crons' | 'requests';
export interface RouteDefinition {
    readonly route: EnterpriseRoute;
    readonly method: 'POST';
    readonly contentType: 'application/json';
    /** Exact validated URL supplied by the active remote snapshot. */
    readonly url: string;
}
export declare class TransportConfigurationError extends Error {
    readonly context: Record<string, unknown>;
    readonly code = "TRANSPORT_CONFIGURATION_ERROR";
    constructor(message: string, context?: Record<string, unknown>);
}
export declare class RouteRegistry {
    private readonly definitions;
    constructor(config: TransportRemoteConfig);
    resolve(event: SDKEvent): RouteDefinition;
    get(route: EnterpriseRoute): RouteDefinition;
    getRoutes(): readonly EnterpriseRoute[];
    routes(): readonly EnterpriseRoute[];
}
