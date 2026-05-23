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
import { RouteTransportManager } from './route-transport-manager.js';
import { getLogger } from '../utils/logger.js';
/** Maps event type to transport route. */
const EVENT_TYPE_TO_ROUTE = {
    span: 'traces',
    request: 'traces',
    error: 'errors',
    message: 'errors',
    log: 'logs',
    metric: 'metrics',
    profile: 'profiles',
    replay: 'replays',
    cron_checkin: 'crons',
};
export class TransportRouter {
    static instance = null;
    routes = new Map();
    transportConfig;
    apiKey;
    disabled = false;
    destroyed = false;
    constructor(config, apiKey) {
        this.transportConfig = config;
        this.apiKey = apiKey;
    }
    static initialize(config, apiKey) {
        if (TransportRouter.instance) {
            void TransportRouter.instance.shutdown();
        }
        TransportRouter.instance = new TransportRouter(config, apiKey);
        TransportRouter.instance.createRoutes();
        return TransportRouter.instance;
    }
    static getInstance() {
        return TransportRouter.instance;
    }
    // ─── Event Routing ────────────────────────────────────────────────────────
    /**
     * Route an event to the appropriate transport.
     * Never throws — drops silently if disabled or route not found.
     */
    send(event) {
        if (this.destroyed || this.disabled)
            return;
        const routeName = EVENT_TYPE_TO_ROUTE[event.type] ?? 'envelope';
        const route = this.routes.get(routeName);
        if (!route) {
            // Fallback to envelope route
            const envelope = this.routes.get('envelope');
            if (envelope) {
                envelope.enqueue(event);
            }
            return;
        }
        route.enqueue(event);
    }
    /**
     * Send multiple events at once.
     */
    sendBatch(events) {
        for (const event of events) {
            this.send(event);
        }
    }
    // ─── Control ──────────────────────────────────────────────────────────────
    /** Disable all transport (killswitch). */
    disable() {
        this.disabled = true;
        getLogger().warn('[TransportRouter] Transport DISABLED (killswitch)');
    }
    /** Re-enable transport (killswitch deactivated). */
    enable() {
        this.disabled = false;
        getLogger().info('[TransportRouter] Transport ENABLED');
    }
    /** Check if transport is disabled. */
    isDisabled() {
        return this.disabled;
    }
    // ─── Config Change ────────────────────────────────────────────────────────
    /** Handle config change — update individual route configs. */
    handleConfigChange(_diff, newConfig) {
        if (this.destroyed)
            return;
        const logger = getLogger();
        const newTransport = newConfig.transport;
        for (const [routeName, endpoint] of Object.entries(newTransport.endpoints)) {
            const route = this.routes.get(routeName);
            if (route) {
                route.updateConfig(endpoint, newTransport.shared);
            }
            else {
                // New route added dynamically
                logger.info(`[TransportRouter] Creating new route: ${routeName}`);
                const newRoute = new RouteTransportManager(routeName, endpoint, newTransport.shared, this.apiKey);
                newRoute.start();
                this.routes.set(routeName, newRoute);
            }
        }
        this.transportConfig = newTransport;
    }
    // ─── Health ───────────────────────────────────────────────────────────────
    /** Get aggregate health across all routes. */
    getHealth() {
        const routes = {};
        for (const [name, route] of this.routes) {
            routes[name] = route.getHealth();
        }
        return {
            routes,
            globalConnectionCount: this.routes.size,
            maxGlobalConnections: this.transportConfig.shared.connectionPool.maxTotalConnections,
            transportDisabled: this.disabled,
        };
    }
    // ─── Lifecycle ────────────────────────────────────────────────────────────
    /** Flush all routes. */
    async flushAll() {
        const promises = [];
        for (const route of this.routes.values()) {
            promises.push(route.flush());
        }
        await Promise.allSettled(promises);
    }
    /** Graceful shutdown — flush all routes and stop. */
    async shutdown() {
        this.destroyed = true;
        const logger = getLogger();
        logger.info('[TransportRouter] Shutting down all routes...');
        const promises = [];
        for (const route of this.routes.values()) {
            promises.push(route.shutdown());
        }
        await Promise.allSettled(promises);
        this.routes.clear();
        TransportRouter.instance = null;
        logger.info('[TransportRouter] All routes shut down');
    }
    // ─── Private ──────────────────────────────────────────────────────────────
    createRoutes() {
        const logger = getLogger();
        for (const [routeName, endpointConfig] of Object.entries(this.transportConfig.endpoints)) {
            const manager = new RouteTransportManager(routeName, endpointConfig, this.transportConfig.shared, this.apiKey);
            manager.start();
            this.routes.set(routeName, manager);
            logger.info(`[TransportRouter] Route created: ${routeName} → ${endpointConfig.url}`);
        }
    }
    static reset() {
        if (TransportRouter.instance) {
            void TransportRouter.instance.shutdown();
        }
    }
}
//# sourceMappingURL=transport-router.js.map