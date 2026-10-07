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
    span: 'spans',
    trace: 'traces',
    request: 'requests',
    metric: 'metrics',
    log: 'logs',
    profile: 'profiles',
    cron_checkin: 'crons',
    replay: 'replays',
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
    getRoutes() {
        return this.routes();
    }
    routes() {
        return ['errors', 'events', 'traces', 'spans', 'metrics', 'logs', 'profiles', 'crons', 'requests', 'replays'];
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
