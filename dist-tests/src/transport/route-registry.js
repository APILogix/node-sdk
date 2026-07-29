export class TransportConfigurationError extends Error {
    context;
    code = 'TRANSPORT_CONFIGURATION_ERROR';
    constructor(message, context = {}) {
        super(message);
        this.context = context;
        this.name = 'TransportConfigurationError';
    }
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
export const UNCONFIGURED_ROUTE_ORIGIN = 'https://unconfigured.invalid';
/** True when a route definition carries a real, backend-supplied URL. */
export function isRouteConfigured(definition) {
    return !definition.url.startsWith(UNCONFIGURED_ROUTE_ORIGIN);
}
const EVENT_TYPE_TO_ROUTE = Object.freeze({
    error: 'errors',
    message: 'events',
    span: 'spans',
    trace: 'traces',
    request: 'requests',
    metric: 'metrics',
    log: 'logs',
    profile: 'profiles',
    cron_checkin: 'crons',
    replay: 'replays',
});
const ROUTE_ENDPOINTS = Object.freeze({
    errors: '/api/v1/errors',
    events: '/api/v1/events',
    traces: '/api/v1/traces',
    spans: '/api/v1/spans',
    metrics: '/api/v1/metrics',
    logs: '/api/v1/logs',
    profiles: '/api/v1/profiles',
    crons: '/api/v1/checkins',
    requests: '/api/v1/requests',
    replays: '/api/v1/replays',
});
export class RouteRegistry {
    definitions;
    constructor(config) {
        this.definitions = Object.freeze({
            errors: createDefinition('errors', config),
            events: createDefinition('events', config),
            traces: createDefinition('traces', config),
            spans: createDefinition('spans', config),
            metrics: createDefinition('metrics', config),
            logs: createDefinition('logs', config),
            profiles: createDefinition('profiles', config),
            crons: createDefinition('crons', config),
            requests: createDefinition('requests', config),
            replays: createDefinition('replays', config),
        });
    }
    resolve(event) {
        const route = EVENT_TYPE_TO_ROUTE[event.type];
        if (!route) {
            throw new TransportConfigurationError('No transport route registered for event type', {
                eventType: event.type,
            });
        }
        return this.definitions[route];
    }
    get(route) {
        return this.definitions[route];
    }
    routes() {
        return ['errors', 'events', 'traces', 'spans', 'metrics', 'logs', 'profiles', 'crons', 'requests', 'replays'];
    }
}
function createDefinition(route, config) {
    const endpoint = ROUTE_ENDPOINTS[route];
    // Map EnterpriseRoute to TransportRouteName for config lookup
    const configRouteName = route;
    // Wire schema renamed `endpoints` → `routes` in v3.
    let configured = config.routes[configRouteName]?.url;
    // Fallback for missing routes in older configs
    if (!configured) {
        if (route === 'events') {
            configured = config.routes['errors']?.url;
        }
        else if (route === 'requests') {
            configured = config.routes['traces']?.url;
        }
        else if (route === 'spans') {
            configured = config.routes['traces']?.url;
        }
        else if (route === 'replays') {
            configured = config.routes['logs']?.url;
        }
    }
    if (!configured) {
        // Route not configured yet (baked-in defaults or a partial remote
        // config). Keep the router constructible — the send path checks
        // isRouteConfigured() and drops with 'route_unconfigured' instead of
        // touching the network.
        configured = UNCONFIGURED_ROUTE_ORIGIN;
    }
    return {
        route,
        endpoint,
        method: 'POST',
        contentType: 'application/json',
        url: forcePath(configured, endpoint),
    };
}
function forcePath(rawUrl, endpoint) {
    const url = new URL(rawUrl);
    url.pathname = endpoint;
    url.search = '';
    url.hash = '';
    return url.toString();
}
