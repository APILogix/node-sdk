import type { SDKEvent } from '../types/event.js';
import type { TransportRemoteConfig } from '../types/config.js';
export type EnterpriseRoute = 'errors' | 'traces' | 'metrics' | 'logs' | 'profiles' | 'crons' | 'requests' | 'replays';
export interface RouteDefinition {
    readonly route: EnterpriseRoute;
    readonly endpoint: '/v1/errors' | '/v1/traces' | '/v1/metrics' | '/v1/logs' | '/v1/profiles' | '/v1/checkins' | '/v1/requests' | '/v1/replays';
    readonly method: 'POST';
    readonly contentType: 'application/json';
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
    routes(): readonly EnterpriseRoute[];
}
//# sourceMappingURL=route-registry.d.ts.map