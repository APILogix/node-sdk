export class TransportConfigurationError extends Error {
    context;
    code = 'TRANSPORT_CONFIGURATION_ERROR';
    constructor(message, context = {}) {
        super(message);
        this.context = context;
        this.name = 'TransportConfigurationError';
    }
}
const EVENT_TYPE_TO_ROUTE = Object.freeze({
    error: 'errors',
    message: 'errors',
    span: 'traces',
    request: 'requests',
    metric: 'metrics',
    log: 'logs',
    profile: 'profiles',
    cron_checkin: 'crons',
    replay: 'replays',
});
const ROUTE_ENDPOINTS = Object.freeze({
    errors: '/v1/errors',
    traces: '/v1/traces',
    metrics: '/v1/metrics',
    logs: '/v1/logs',
    profiles: '/v1/profiles',
    crons: '/v1/checkins',
    requests: '/v1/requests',
    replays: '/v1/replays',
});
export class RouteRegistry {
    definitions;
    constructor(config) {
        this.definitions = Object.freeze({
            errors: createDefinition('errors', config),
            traces: createDefinition('traces', config),
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
        return ['errors', 'traces', 'metrics', 'logs', 'profiles', 'crons', 'requests', 'replays'];
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
        if (route === 'requests') {
            configured = config.routes['traces']?.url;
        }
        else if (route === 'replays') {
            configured = config.routes['logs']?.url;
        }
    }
    if (!configured) {
        throw new TransportConfigurationError('Missing endpoint for route', { route });
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
//# sourceMappingURL=route-registry.js.map