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
    message: 'events',
    event: 'events',
    span: 'spans',
    trace: 'traces',
    request: 'requests',
    metric: 'metrics',
    log: 'logs',
    profile: 'profiles',
    cron_checkin: 'crons',
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
        });
    }
    isCanonicalType(type) {
        return Object.prototype.hasOwnProperty.call(EVENT_TYPE_TO_ROUTE, type);
    }
    resolve(event) {
        const eventType = (event && typeof event === 'object' && typeof event.type === 'string') ? event.type : 'message';
        const route = EVENT_TYPE_TO_ROUTE[eventType] ?? 'events';
        return this.definitions[route];
    }
    get(route) {
        return this.definitions[route];
    }
    getRoutes() {
        return this.routes();
    }
    routes() {
        return ['errors', 'events', 'traces', 'spans', 'metrics', 'logs', 'profiles', 'crons', 'requests'];
    }
}
function createDefinition(route, config) {
    return {
        route,
        method: 'POST',
        contentType: 'application/json',
        url: config.routes[route].url,
    };
}
