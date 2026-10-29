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
import { RouteRegistry, TransportConfigurationError } from './route-registry.js';
import { TransportEventQueue } from './transport-event-queue.js';
import { validateApiKey } from '../core/api-key.js';
import { SerializationPool } from './serialization-pool.js';
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
const MIN_BATCH_SIZE = Object.freeze({
    errors: 1,
    events: 1,
    traces: 10,
    spans: 10,
    metrics: 50,
    logs: 10,
    profiles: 1,
    crons: 1,
    requests: 10,
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
    reconfiguration = Promise.resolve();
    disabled = false;
    destroyed = false;
    dropped = [];
    dropLogCount = 0;
    constructor(transportConfig, apiKey, fetchImpl, limitsConfig) {
        this.transportConfig = transportConfig;
        this.apiKey = apiKey;
        this.fetchImpl = fetchImpl;
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
    static async initialize(config, apiKey, fetchImpl, limitsConfig) {
        validateApiKey(apiKey);
        if (!limitsConfig) {
            throw new TransportConfigurationError('Complete limits config is required');
        }
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
        SerializationPool.initialize(1);
        const router = new TransportRouter(config, apiKey, fetchImpl ?? fetch, limitsConfig);
        router.sendBatch(residual);
        TransportRouter.instance = router;
        return router;
    }
    static getInstance() {
        return TransportRouter.instance;
    }
    send(event) {
        if (this.destroyed || this.disabled) {
            let route = 'events';
            try {
                route = this.registry.resolve(event).route;
            }
            catch { }
            this.recordDrop({
                route,
                reason: 'transport_disabled',
                count: 1,
                eventType: event.type,
            });
            return false;
        }
        try {
            const definition = this.registry.resolve(event);
            if (!this.registry.isCanonicalType(event.type) && event.customType === undefined) {
                ;
                event.customType = event.type;
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
    updateTransport(transport, limits) {
        if (this.destroyed)
            return Promise.resolve();
        const operation = this.reconfiguration.then(async () => {
            if (this.destroyed)
                return;
            // Candidate construction validates every route and allocates all queues
            // before any live reference changes. A failure leaves the old runtime intact.
            // Preserving this.healthMonitor prevents wiping OPEN circuit breakers during config refreshes.
            const candidate = this.buildRuntime(transport, limits, this.healthMonitor);
            const oldManagers = this.batchManagers;
            const oldQueues = this.queues;
            const queued = [];
            for (const queue of oldQueues.values())
                queued.push(...queue.drain(queue.size()));
            // One synchronous commit point: send() observes the new runtime immediately,
            // ensuring any concurrent sends during the quiesce window are enqueued to the new managers.
            this.transportConfig = transport;
            this.registry = candidate.registry;
            this.connectionManager = candidate.connectionManager;
            this.healthMonitor = candidate.healthMonitor;
            this.batchManagers = candidate.batchManagers;
            this.queues = candidate.queues;
            // Quiesce detached managers. Failed/in-flight batches are returned to
            // their old queues by BatchManager.shutdown(), then migrated exactly once.
            const shutdownResults = await Promise.allSettled([...oldManagers.values()].map(manager => manager.shutdown()));
            const residual = [];
            for (const result of shutdownResults) {
                if (result.status === 'fulfilled')
                    residual.push(...result.value);
                else
                    getLogger().warn('[TransportRouter] Detached manager shutdown failed', { error: result.reason });
            }
            for (const queue of oldQueues.values())
                residual.push(...queue.drain(queue.size()));
            // Chronological order: older residual/in-flight events migrate first, followed by queued
            if (residual.length > 0) {
                for (const event of residual) {
                    const def = this.registry.resolve(event);
                    const q = this.queues.get(def.route);
                    if (q) {
                        q.requeueFront([event]);
                    }
                    else {
                        this.send(event);
                    }
                }
            }
            if (queued.length > 0)
                this.sendBatch(queued);
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
        const inFlightSends = { errors: 0, events: 0, traces: 0, spans: 0, metrics: 0, logs: 0, profiles: 0, crons: 0, requests: 0 };
        const queuedEvents = { errors: 0, events: 0, traces: 0, spans: 0, metrics: 0, logs: 0, profiles: 0, crons: 0, requests: 0 };
        const batchedEvents = { errors: 0, events: 0, traces: 0, spans: 0, metrics: 0, logs: 0, profiles: 0, crons: 0, requests: 0 };
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
        await Promise.allSettled([...this.batchManagers.values()].map(manager => manager.flush()));
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
    /** Snapshot queued, retrying, and active batches for a synchronous exit hook. */
    drainAllForExit() {
        const residual = [];
        const seen = new Set();
        for (const manager of this.batchManagers.values()) {
            for (const event of manager.drainForExit()) {
                const id = event.eventId ?? '';
                if (id && seen.has(id))
                    continue;
                if (id)
                    seen.add(id);
                residual.push(event);
            }
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
        const shutdownResults = await Promise.allSettled([...this.batchManagers.values()].map(manager => manager.shutdown()));
        for (const result of shutdownResults) {
            if (result.status === 'rejected') {
                getLogger().warn('[TransportRouter] BatchManager shutdown failed', { error: result.reason });
            }
            else {
                residual.push(...result.value);
            }
        }
        // Phase 2: collect every undelivered item after active sends/retries have
        // quiesced. Callers persist or migrate this residual before references clear.
        residual.push(...this.drainAllQueues());
        this.batchManagers.clear();
        this.queues.clear();
        this.dropped.length = 0;
        this.dropLogCount = 0;
        if (TransportRouter.instance === this) {
            TransportRouter.instance = null;
        }
        await SerializationPool.reset();
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
    buildRuntime(config, limits, existingHealthMonitor) {
        const registry = new RouteRegistry(config);
        const healthMonitor = existingHealthMonitor ?? new HealthMonitor(registry.routes());
        const connectionManager = this.createConnectionManager(config);
        const queues = new Map();
        const batchManagers = new Map();
        const overflowStrategy = config.queue.overflowStrategy;
        for (const route of registry.routes()) {
            const routeRemote = config.routes[route];
            const priority = toQueuePriority(routeRemote.priority);
            if (!priority)
                throw new TransportConfigurationError('Route priority is invalid', { route });
            const maxSize = config.queue.maxSize;
            // Authoritative Enterprise Compression Policy:
            // - 'crons' is NEVER compressed ('none') — tiny single check-ins (~150B); avoids negative gzip expansion.
            // - All other telemetry routes ('traces', 'spans', 'requests', 'metrics', 'logs', 'profiles', 'errors', 'events')
            //   are ALWAYS gzip-compressed ('gzip') irrespective of remote config.
            const effectiveCompression = route === 'crons' ? 'none' : 'gzip';
            getLogger().debug('[TransportRouter] Configured route', {
                route,
                batchSize: routeRemote.batchSize,
                flushIntervalMs: routeRemote.flushIntervalMs,
                timeoutMs: routeRemote.timeoutMs,
                configuredCompression: routeRemote.compression,
                effectiveCompression,
                priority: routeRemote.priority,
            });
            const queue = new TransportEventQueue({
                route,
                maxSize,
                criticalReserve: config.queue.criticalReserve,
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
                maxBatchSize: routeRemote.batchSize,
                minBatchSize: Math.min(MIN_BATCH_SIZE[route], routeRemote.batchSize),
                maxWaitTimeMs: routeRemote.flushIntervalMs,
                maxPayloadBytes: limits.maxPayloadSize,
                socketTimeoutMs: routeRemote.timeoutMs,
                compression: effectiveCompression,
                keepAlive: config.keepAlive,
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
        const requested = config.connections.maxConnectionsPerRoute;
        const perRoute = Object.fromEntries(Object.keys(config.routes).map(route => [route, requested?.[route] ?? config.connections.maxTotalConnections]));
        return new ConnectionManager({
            maxTotalConnections: config.connections.maxTotalConnections,
            maxConnectionsPerRoute: perRoute,
            connectionTimeoutMs: config.connections.acquireTimeoutMs,
            socketTimeoutMs: 30_000,
            connectionTTLMs: 60_000,
            idleConnectionTimeoutMs: 30_000,
        });
    }
    routeHealth(route) {
        const definition = this.registry.get(route);
        const stats = this.batchManagers.get(route)?.stats() ?? createEmptyStats(route);
        const health = this.healthMonitor.snapshot(route);
        const priority = toQueuePriority(this.transportConfig.routes[route].priority);
        if (!priority)
            throw new TransportConfigurationError('Route priority is invalid', { route });
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
function createEmptyStats(route) {
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
