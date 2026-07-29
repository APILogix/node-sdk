/**
 * Unified TransportRouter.
 *
 * One singleton owns outbound telemetry delivery for the SDK lifecycle:
 * event classification, bounded queues, adaptive batchers, route health,
 * and one shared connection manager with global and per-route limits.
 */
import { getLogger } from '../utils/logger.js';
import { BatchManager } from './batch-manager.js';
import { ConnectionManager } from './connection-manager.js';
import { HealthMonitor } from './health-monitor.js';
import { RouteRegistry, TransportConfigurationError, isRouteConfigured } from './route-registry.js';
import { TransportEventQueue } from './transport-event-queue.js';
import { MultiplexedTransport } from './multiplexed-transport.js';
import { SAFE_DEFAULTS_LIMITS, SAFETY_CEILINGS, SAFETY_FLOORS } from '../constants/defaults.js';
import { validateApiKey } from './sender.js';
/**
 * Clamp a remote-config number into a safe range. The config manager already
 * clamps during merge; this is defence-in-depth for direct construction
 * (tests, warm-start replays, hand-built configs).
 */
function clampInt(value, min, max, fallback) {
    if (!Number.isFinite(value))
        return fallback;
    return Math.min(max, Math.max(min, Math.floor(value)));
}
/** Map the wire priority onto the queue's three-tier priority. */
function toQueuePriority(priority) {
    if (priority === 'critical' || priority === 'high')
        return 'high';
    if (priority === 'normal')
        return 'normal';
    if (priority === 'low')
        return 'low';
    return undefined;
}
const QUEUE_CONFIG = Object.freeze({
    errors: Object.freeze({ maxSize: 10_000, priority: 'high' }),
    events: Object.freeze({ maxSize: 10_000, priority: 'high' }),
    traces: Object.freeze({ maxSize: 50_000, priority: 'normal' }),
    spans: Object.freeze({ maxSize: 50_000, priority: 'normal' }),
    metrics: Object.freeze({ maxSize: 25_000, priority: 'low' }),
    logs: Object.freeze({ maxSize: 25_000, priority: 'normal' }),
    profiles: Object.freeze({ maxSize: 5_000, priority: 'low' }),
    crons: Object.freeze({ maxSize: 1_000, priority: 'high' }),
    requests: Object.freeze({ maxSize: 50_000, priority: 'normal' }),
    replays: Object.freeze({ maxSize: 5_000, priority: 'low' }),
});
const BATCH_CONFIG = Object.freeze({
    errors: Object.freeze({ maxBatchSize: 100, maxWaitTimeMs: 1_000, minBatchSize: 1 }),
    events: Object.freeze({ maxBatchSize: 100, maxWaitTimeMs: 1_000, minBatchSize: 1 }),
    traces: Object.freeze({ maxBatchSize: 500, maxWaitTimeMs: 5_000, minBatchSize: 10 }),
    spans: Object.freeze({ maxBatchSize: 500, maxWaitTimeMs: 5_000, minBatchSize: 10 }),
    metrics: Object.freeze({ maxBatchSize: 1_000, maxWaitTimeMs: 10_000, minBatchSize: 50 }),
    logs: Object.freeze({ maxBatchSize: 200, maxWaitTimeMs: 10_000, minBatchSize: 10 }),
    profiles: Object.freeze({ maxBatchSize: 5, maxWaitTimeMs: 30_000, minBatchSize: 1 }),
    crons: Object.freeze({ maxBatchSize: 1, maxWaitTimeMs: 0, minBatchSize: 1 }),
    requests: Object.freeze({ maxBatchSize: 500, maxWaitTimeMs: 5_000, minBatchSize: 10 }),
    replays: Object.freeze({ maxBatchSize: 5, maxWaitTimeMs: 10_000, minBatchSize: 1 }),
});
const CONNECTION_LIMITS = Object.freeze({
    errors: 30,
    events: 30,
    traces: 50,
    spans: 50,
    metrics: 20,
    logs: 20,
    profiles: 5,
    crons: 5,
    requests: 50,
    replays: 10,
});
export class TransportRouter {
    transportConfig;
    apiKey;
    fetchImpl;
    static instance = null;
    registry;
    connectionManager;
    healthMonitor;
    batchManagers;
    queues;
    limitsConfig;
    reconfiguration = Promise.resolve();
    disabled = false;
    destroyed = false;
    dropped = [];
    dropLogCount = 0;
    multiplexed = null;
    useMultiplexedTransport = false;
    constructor(transportConfig, apiKey, fetchImpl = fetch, limitsConfig = SAFE_DEFAULTS_LIMITS) {
        this.transportConfig = transportConfig;
        this.apiKey = apiKey;
        this.fetchImpl = fetchImpl;
        this.limitsConfig = limitsConfig;
        const runtime = this.buildRuntime(transportConfig, limitsConfig);
        this.registry = runtime.registry;
        this.healthMonitor = runtime.healthMonitor;
        this.connectionManager = runtime.connectionManager;
        this.queues = runtime.queues;
        this.batchManagers = runtime.batchManagers;
    }
    /**
     * Initialize the singleton transport router.
     *
     * If a previous instance exists, this method awaits its shutdown before
     * installing the new instance. This prevents a stale BatchManager from
     * sending events through an out-of-date connection manager during a warm
     * reinit.
     *
     * NOTE: This method is async because shutdown drains in-flight batches.
     * Callers must await the returned promise before sending events.
     */
    static async initialize(config, apiKey, fetchImpl, useMultiplexedTransport = false, limitsConfig = SAFE_DEFAULTS_LIMITS) {
        // The apiKey is interpolated into an `Authorization` HTTP header on
        // every batch send — reject control characters before they can smuggle
        // header lines. Throws SDKError on an illegal key.
        validateApiKey(apiKey);
        let residual = [];
        if (TransportRouter.instance) {
            try {
                residual = await TransportRouter.instance.shutdown();
            }
            catch (err) {
                getLogger().warn('[TransportRouter] Previous instance shutdown failed during reinit', { error: err });
            }
            TransportRouter.instance = null;
        }
        const router = new TransportRouter(config, apiKey, fetchImpl, limitsConfig);
        router.sendBatch(residual);
        router.useMultiplexedTransport = useMultiplexedTransport;
        if (useMultiplexedTransport) {
            const baseUrl = new URL(router.registry.get('traces').url).origin;
            const flushIntervalMs = clampInt(router.transportConfig.routes.traces?.flushIntervalMs ?? NaN, SAFETY_FLOORS.flushIntervalMs, SAFETY_CEILINGS.flushIntervalMs, 2000);
            router.multiplexed = new MultiplexedTransport(baseUrl, apiKey, flushIntervalMs);
        }
        TransportRouter.instance = router;
        return router;
    }
    static getInstance() {
        return TransportRouter.instance;
    }
    send(event) {
        if (this.destroyed || this.disabled) {
            this.recordDrop({
                route: 'errors',
                reason: 'transport_disabled',
                count: 1,
                eventType: event.type,
            });
            return false;
        }
        try {
            const definition = this.registry.resolve(event);
            if (!isRouteConfigured(definition)) {
                // No real endpoint for this route yet (baked-in defaults or a
                // partial remote config). Drop locally with a visible reason
                // instead of leaking traffic to the placeholder origin.
                this.recordDrop({
                    route: definition.route,
                    reason: 'route_unconfigured',
                    count: 1,
                    eventType: event.type,
                });
                return false;
            }
            if (this.useMultiplexedTransport && this.multiplexed) {
                this.multiplexed.enqueue(definition.route, [event]);
                return true;
            }
            const manager = this.batchManagers.get(definition.route);
            if (!manager) {
                throw new TransportConfigurationError('Route has no batch manager', {
                    route: definition.route,
                    eventType: event.type,
                });
            }
            return manager.enqueue(event);
        }
        catch (error) {
            const logger = getLogger();
            logger.error('[TransportRouter] Event dropped due to route configuration error', {
                error,
                eventType: event.type,
            });
            return false;
        }
    }
    sendBatch(events) {
        for (const event of events) {
            this.send(event);
        }
    }
    disable() {
        this.disabled = true;
        getLogger().warn('[TransportRouter] Transport disabled');
    }
    enable() {
        this.disabled = false;
        getLogger().info('[TransportRouter] Transport enabled');
    }
    isDisabled() {
        return this.disabled;
    }
    handleConfigChange(_diff, newConfig) {
        return this.updateTransport(newConfig.transport, newConfig.limits);
    }
    /** Build-then-swap transport reconfiguration serialized across refreshes. */
    updateTransport(transport, limits = this.limitsConfig) {
        if (this.destroyed)
            return Promise.resolve();
        const operation = this.reconfiguration.then(async () => {
            if (this.destroyed)
                return;
            // Candidate construction validates every route and allocates all queues
            // before any live reference changes. A failure leaves the old runtime intact.
            const candidate = this.buildRuntime(transport, limits);
            const oldManagers = this.batchManagers;
            const oldQueues = this.queues;
            const queued = [];
            for (const queue of oldQueues.values())
                queued.push(...queue.drain(queue.size()));
            // One synchronous commit point: send() observes either complete runtime.
            this.transportConfig = transport;
            this.limitsConfig = limits;
            this.registry = candidate.registry;
            this.connectionManager = candidate.connectionManager;
            this.healthMonitor = candidate.healthMonitor;
            this.batchManagers = candidate.batchManagers;
            this.queues = candidate.queues;
            this.sendBatch(queued);
            // Quiesce detached managers. Failed/in-flight batches are returned to
            // their old queues by BatchManager.shutdown(), then migrated exactly once.
            await Promise.allSettled([...oldManagers.values()].map(manager => manager.shutdown()));
            const residual = [];
            for (const queue of oldQueues.values())
                residual.push(...queue.drain(queue.size()));
            this.sendBatch(residual);
        });
        this.reconfiguration = operation.catch(error => {
            getLogger().error('[TransportRouter] Transport reconfiguration failed; previous runtime retained', { error });
        });
        return operation;
    }
    getHealth() {
        const routes = {};
        for (const route of this.registry.routes()) {
            routes[route] = this.routeHealth(route);
        }
        const pool = this.connectionManager.stats();
        return {
            routes,
            globalConnectionCount: pool.totalInUse,
            maxGlobalConnections: pool.maxTotalConnections,
            transportDisabled: this.disabled,
        };
    }
    getDebugState() {
        const inFlightSends = { errors: 0, events: 0, traces: 0, spans: 0, metrics: 0, logs: 0, profiles: 0, crons: 0, requests: 0, replays: 0 };
        const queuedEvents = { errors: 0, events: 0, traces: 0, spans: 0, metrics: 0, logs: 0, profiles: 0, crons: 0, requests: 0, replays: 0 };
        const batchedEvents = { errors: 0, events: 0, traces: 0, spans: 0, metrics: 0, logs: 0, profiles: 0, crons: 0, requests: 0, replays: 0 };
        for (const route of this.registry.routes()) {
            const stats = this.batchManagers.get(route)?.stats();
            inFlightSends[route] = stats?.inFlightSends ?? 0;
            queuedEvents[route] = stats?.queuedEvents ?? 0;
            batchedEvents[route] = stats?.batchedEvents ?? 0;
        }
        return {
            inFlightSends,
            queuedEvents,
            batchedEvents,
            droppedEvents: [...this.dropped],
        };
    }
    async flushAll() {
        await this.reconfiguration;
        if (this.useMultiplexedTransport && this.multiplexed) {
            await this.multiplexed.flush();
        }
        else {
            await Promise.allSettled([...this.batchManagers.values()].map(manager => manager.flush()));
        }
    }
    /**
     * Drain every per-route queue and return the residual events.
     *
     * Called from the shutdown lifecycle AFTER `flushAll()` has done its best
     * to deliver everything via the network. Anything still in the queues at
     * this point is undelivered and would otherwise be lost when the process
     * exits — the lifecycle layer pipes these into `persistentStorage` so they
     * are replayed on the next start.
     *
     * Returns events in arbitrary route order. The caller is responsible for
     * persisting them; this method does not touch the filesystem itself so
     * tests can run without it.
     */
    drainAllQueues() {
        const residual = [];
        for (const queue of this.queues.values()) {
            const size = queue.size();
            if (size === 0)
                continue;
            residual.push(...queue.drain(size));
        }
        return residual;
    }
    async shutdown() {
        if (this.destroyed)
            return this.drainAllQueues();
        this.destroyed = true;
        const residual = [];
        await this.reconfiguration.catch(() => undefined);
        // Phase 1: shut down each batch manager so in-flight HTTP sends complete.
        // We use shutdown (not flush) so the manager rejects new enqueues during
        // its own drain.
        if (this.useMultiplexedTransport && this.multiplexed) {
            try {
                await this.multiplexed.shutdown();
            }
            catch (err) {
                getLogger().warn('[TransportRouter] MultiplexedTransport shutdown failed', { error: err });
            }
        }
        else {
            const shutdownResults = await Promise.allSettled([...this.batchManagers.values()].map(manager => manager.shutdown()));
            for (const result of shutdownResults) {
                if (result.status === 'rejected') {
                    getLogger().warn('[TransportRouter] BatchManager shutdown failed', { error: result.reason });
                }
                else {
                    residual.push(...result.value);
                }
            }
        }
        // Phase 2: collect every undelivered item after active sends/retries have
        // quiesced. Callers persist or migrate this residual before references clear.
        residual.push(...this.drainAllQueues());
        this.batchManagers.clear();
        this.queues.clear();
        this.dropped.length = 0;
        this.dropLogCount = 0;
        // Phase 3: detach the singleton pointer only if it still references this
        // instance — concurrent reinit may have already swapped it out.
        if (TransportRouter.instance === this) {
            TransportRouter.instance = null;
        }
        return residual;
    }
    static async reset() {
        const inst = TransportRouter.instance;
        if (inst) {
            try {
                await inst.shutdown();
            }
            catch (err) {
                getLogger().warn('[TransportRouter] reset failed', { error: err });
            }
        }
        TransportRouter.instance = null;
    }
    buildRuntime(config, limits) {
        const registry = new RouteRegistry(config);
        const healthMonitor = new HealthMonitor(registry.routes());
        const connectionManager = this.createConnectionManager(config);
        const queues = new Map();
        const batchManagers = new Map();
        const overflowStrategy = config.queue.overflowStrategy;
        for (const route of registry.routes()) {
            const queueConfig = QUEUE_CONFIG[route];
            const batchConfig = BATCH_CONFIG[route];
            const routeRemote = config.routes[route];
            const maxBatchSize = clampInt(routeRemote?.batchSize ?? NaN, 1, SAFETY_CEILINGS.batchSize, batchConfig.maxBatchSize);
            const maxWaitTimeMs = clampInt(routeRemote?.flushIntervalMs ?? NaN, 0, SAFETY_CEILINGS.flushIntervalMs, batchConfig.maxWaitTimeMs);
            const socketTimeoutMs = clampInt(routeRemote?.timeoutMs ?? NaN, SAFETY_FLOORS.timeoutMs, SAFETY_CEILINGS.timeoutMs, 30_000);
            const priority = toQueuePriority(routeRemote?.priority) ?? queueConfig.priority;
            const requestedQueueSize = config.queue.maxSize ?? limits.maxQueueSize;
            const maxSize = clampInt(Math.min(queueConfig.maxSize, requestedQueueSize, limits.maxQueueSize), 1, SAFETY_CEILINGS.maxQueueSize, Math.min(queueConfig.maxSize, SAFE_DEFAULTS_LIMITS.maxQueueSize));
            const queue = new TransportEventQueue({
                route,
                maxSize,
                priority,
                overflowStrategy,
                onDrop: info => this.recordDrop(info),
            });
            const manager = new BatchManager({
                route,
                definition: registry.get(route),
                apiKey: this.apiKey,
                queue,
                connectionManager,
                healthMonitor,
                maxBatchSize,
                minBatchSize: Math.min(batchConfig.minBatchSize, maxBatchSize),
                maxWaitTimeMs,
                maxPayloadBytes: clampInt(limits.maxPayloadSize, 1_024, SAFETY_CEILINGS.maxPayloadSize, SAFE_DEFAULTS_LIMITS.maxPayloadSize),
                socketTimeoutMs,
                retry: config.retry,
                onDrop: info => this.recordDrop(info),
                fetchImpl: this.fetchImpl,
            });
            queues.set(route, queue);
            batchManagers.set(route, manager);
        }
        return { registry, healthMonitor, connectionManager, queues, batchManagers };
    }
    createConnectionManager(config) {
        const requested = config.connections?.maxConnectionsPerRoute;
        const perRoute = { ...CONNECTION_LIMITS };
        for (const route of Object.keys(perRoute)) {
            const value = requested?.[route];
            if (typeof value === 'number')
                perRoute[route] = clampInt(value, 1, 100, CONNECTION_LIMITS[route]);
        }
        return new ConnectionManager({
            maxTotalConnections: clampInt(config.connections?.maxTotalConnections ?? NaN, 1, 500, 100),
            maxConnectionsPerRoute: perRoute,
            connectionTimeoutMs: clampInt(config.connections?.acquireTimeoutMs ?? NaN, 100, 60_000, 5_000),
            socketTimeoutMs: 30_000,
            connectionTTLMs: 60_000,
            idleConnectionTimeoutMs: 30_000,
        });
    }
    routeHealth(route) {
        const definition = this.registry.get(route);
        const stats = this.batchManagers.get(route)?.stats() ?? emptyStats(route);
        const health = this.healthMonitor.snapshot(route);
        const priority = toQueuePriority(this.transportConfig.routes[route]?.priority) ?? QUEUE_CONFIG[route].priority;
        return {
            route,
            url: definition.url,
            priority,
            queueSize: stats.queuedEvents,
            queueCapacity: this.queues.get(route)?.maxSize ?? 0,
            inFlightCount: stats.inFlightSends,
            totalSent: stats.totalSent,
            totalFailed: stats.totalFailed,
            totalDropped: stats.totalDropped,
            totalRetries: stats.totalRetries,
            circuitState: health.circuitState === 'OPEN'
                ? 'OPEN'
                : health.circuitState === 'HALF_OPEN'
                    ? 'HALF_OPEN'
                    : 'CLOSED',
            lastSendAt: health.lastSuccessAt,
            lastErrorAt: health.lastErrorAt,
            avgLatencyMs: health.avgLatencyMs,
        };
    }
    recordDrop(info) {
        this.dropped.push(info);
        if (this.dropped.length > 500)
            this.dropped.shift();
        this.dropLogCount++;
        if (this.dropLogCount <= 10 || this.dropLogCount % 1000 === 0) {
            getLogger().warn('[TransportRouter] Event dropped', { ...info, totalDropNotifications: this.dropLogCount });
        }
    }
}
function emptyStats(route) {
    return {
        route,
        queuedEvents: 0,
        batchedEvents: 0,
        inFlightSends: 0,
        totalSent: 0,
        totalDropped: 0,
        totalFailed: 0,
        totalRetries: 0,
        totalRequests: 0,
        avgBatchSize: 0,
    };
}
