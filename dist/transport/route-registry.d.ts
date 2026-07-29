import type { SDKEvent } from '../types/event.js';
import type { TransportRemoteConfig } from '../types/config.js';
export type EnterpriseRoute = 'errors' | 'events' | 'traces' | 'spans' | 'metrics' | 'logs' | 'profiles' | 'crons' | 'requests' | 'replays';
export interface RouteDefinition {
    readonly route: EnterpriseRoute;
    readonly endpoint: '/api/v1/errors' | '/api/v1/events' | '/api/v1/traces' | '/api/v1/spans' | '/api/v1/metrics' | '/api/v1/logs' | '/api/v1/profiles' | '/api/v1/checkins' | '/api/v1/requests' | '/api/v1/replays';
    readonly method: 'POST';
    readonly contentType: 'application/json';
    readonly url: string;
}
export declare class TransportConfigurationError extends Error {
    readonly context: Record<string, unknown>;
    readonly code = "TRANSPORT_CONFIGURATION_ERROR";
    constructor(message: string, context?: Record<string, unknown>);
}
/**
 * Origin used for routes whose URL is not configured yet. The baked-in
 * defaults ship `url: ''` for every route (transport stays off until the
 * first remote config delivers real endpoints), so the router must still
 * construct cleanly with placeholder URLs — a monitoring SDK must never
 * throw during init just because the control plane hasn't provided
 * endpoints yet. `.invalid` is reserved by RFC 2606: even if a bug
 * bypassed every guard and attempted a send, DNS resolution fails
 * instantly instead of leaking telemetry to a real host.
 */
export declare const UNCONFIGURED_ROUTE_ORIGIN = "https://unconfigured.invalid";
/** True when a route definition carries a real, backend-supplied URL. */
export declare function isRouteConfigured(definition: RouteDefinition): boolean;
export declare class RouteRegistry {
    private readonly definitions;
    constructor(config: TransportRemoteConfig);
    resolve(event: SDKEvent): RouteDefinition;
    get(route: EnterpriseRoute): RouteDefinition;
    routes(): readonly EnterpriseRoute[];
}
//# sourceMappingURL=route-registry.d.ts.map