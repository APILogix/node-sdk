import { getLogger } from '../utils/logger.js';
import { TransportEventQueue } from './transport-event-queue.js';
import { ConnectionManager } from './connection-manager.js';
import { HealthMonitor } from './health-monitor.js';
export class BatchManager {
    options;
    timer = null;
    activeSends = 0;
    batched = 0;
    totalSent = 0;
    totalDropped = 0;
    totalFailed = 0;
    totalRequests = 0;
    totalBatchEvents = 0;
    destroyed = false;
    firstQueuedAt = 0;
    fetchImpl;
    constructor(options) {
        this.options = options;
        this.fetchImpl = options.fetchImpl ?? fetch;
    }
    enqueue(event) {
        if (this.destroyed)
            return false;
        const accepted = this.options.queue.enqueue(event);
        if (!accepted) {
            this.totalDropped++;
            return false;
        }
        if (!this.firstQueuedAt)
            this.firstQueuedAt = Date.now();
        if (this.options.queue.size() >= this.effectiveMaxBatchSize()) {
            this.pump();
        }
        else {
            this.ensureTimer();
        }
        return true;
    }
    /**
     * Drain the queue. Bounded so a permanently-unreachable endpoint cannot
     * keep flush() spinning forever — re-queued failures eventually exhaust
     * the retry budget and the residual events are surrendered to the queue
     * for the upstream lifecycle/persistence layer to handle.
     */
    async flush() {
        this.clearTimer();
        const FLUSH_DEADLINE_MS = 4_000; // Bounded so caller's outer timeout wins
        const FLUSH_MAX_FAILED_REQUESTS = 5;
        const startedAt = Date.now();
        const failedAtStart = this.totalFailed;
        const droppedAtStart = this.totalDropped;
        while (!this.options.queue.isEmpty() || this.activeSends > 0) {
            this.pump(true);
            if (this.activeSends === 0 && this.options.queue.isEmpty())
                break;
            // Bail if the deadline has passed — the outer shutdown timeout will
            // surface this via stepErrors. Better than spinning forever.
            if (Date.now() - startedAt > FLUSH_DEADLINE_MS)
                break;
            // Bail if we've accumulated too many failures during this single flush
            // cycle — the endpoint is unreachable and re-queuing is making the
            // problem worse. Surrender residual events to the caller (which
            // typically persists them to disk).
            const newFailures = (this.totalFailed - failedAtStart) + (this.totalDropped - droppedAtStart);
            if (newFailures >= FLUSH_MAX_FAILED_REQUESTS)
                break;
            await sleep(10);
        }
    }
    async shutdown() {
        this.destroyed = true;
        await this.flush();
    }
    stats() {
        return {
            route: this.options.route,
            queuedEvents: this.options.queue.size(),
            batchedEvents: this.batched,
            inFlightSends: this.activeSends,
            totalSent: this.totalSent,
            totalDropped: this.totalDropped + this.options.queue.droppedCount(),
            totalFailed: this.totalFailed,
            totalRequests: this.totalRequests,
            avgBatchSize: this.totalRequests > 0 ? this.totalBatchEvents / this.totalRequests : 0,
        };
    }
    pump(force = false) {
        if (this.destroyed && !force)
            return;
        if (!this.options.healthMonitor.canSend(this.options.route)) {
            this.ensureTimer(true);
            return;
        }
        const concurrency = this.effectiveConcurrency();
        while (this.activeSends < concurrency && !this.options.queue.isEmpty()) {
            if (!force && this.options.queue.size() < this.options.minBatchSize && !this.maxWaitElapsed()) {
                this.ensureTimer();
                break;
            }
            const batch = this.nextSerializableBatch();
            if (batch.length === 0)
                break;
            this.activeSends++;
            this.batched += batch.length;
            void this.sendBatch(batch);
        }
    }
    nextSerializableBatch() {
        const targetSize = this.effectiveMaxBatchSize();
        let batch = this.options.queue.drain(targetSize);
        while (batch.length > 0) {
            const payloadBytes = this.byteLength(batch);
            // Sentinel: serialization itself failed (e.g., circular ref). The
            // bad events have already been dropped+reported by byteLength, so
            // don't requeue or try to split — that would re-serialize the same
            // bad payload and double-count the drop in stats.
            if (payloadBytes < 0)
                return [];
            if (payloadBytes <= this.options.maxPayloadBytes)
                return batch;
            if (batch.length === 1) {
                this.totalDropped++;
                this.options.onDrop?.({
                    route: this.options.route,
                    reason: 'event_too_large',
                    count: 1,
                    eventType: batch[0]?.type,
                });
                return [];
            }
            const half = Math.max(1, Math.floor(batch.length / 2));
            const overflow = batch.splice(half);
            this.options.queue.requeueFront(overflow);
        }
        return [];
    }
    async sendBatch(batch) {
        const startedAt = Date.now();
        const lease = await this.options.connectionManager.acquire(this.options.route);
        if (!lease) {
            this.activeSends--;
            this.batched -= batch.length;
            this.totalFailed += batch.length;
            this.options.queue.requeueFront(batch);
            this.ensureTimer(true);
            return;
        }
        try {
            const body = JSON.stringify({
                events: batch,
                route: this.options.route,
                timestamp: Date.now(),
            });
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), this.options.socketTimeoutMs);
            timeout.unref?.();
            try {
                const response = await this.fetchImpl(this.options.definition.url, {
                    method: this.options.definition.method,
                    headers: {
                        'Content-Type': this.options.definition.contentType,
                        Authorization: `Bearer ${this.options.apiKey}`,
                        'X-Route': this.options.route,
                        'x-pulse-internal': '1',
                    },
                    body,
                    signal: controller.signal,
                });
                const latency = Date.now() - startedAt;
                if (response.ok) {
                    this.options.healthMonitor.recordSuccess(this.options.route, latency);
                    this.totalSent += batch.length;
                    this.totalRequests++;
                    this.totalBatchEvents += batch.length;
                }
                else if (response.status >= 500 || response.status === 429 || response.status === 408) {
                    this.options.healthMonitor.recordFailure(this.options.route);
                    this.totalFailed += batch.length;
                    this.options.queue.requeueFront(batch);
                }
                else {
                    this.options.healthMonitor.recordFailure(this.options.route);
                    this.totalDropped += batch.length;
                    this.options.onDrop?.({
                        route: this.options.route,
                        reason: 'route_unavailable',
                        count: batch.length,
                        eventType: batch[0]?.type,
                    });
                }
            }
            finally {
                clearTimeout(timeout);
            }
        }
        catch (error) {
            this.options.healthMonitor.recordFailure(this.options.route);
            this.totalFailed += batch.length;
            this.options.queue.requeueFront(batch);
            getLogger().warn('[TransportRouter] Batch send failed', {
                route: this.options.route,
                error: error instanceof Error ? error.message : String(error),
                eventCount: batch.length,
            });
        }
        finally {
            lease.release(true);
            this.activeSends--;
            this.batched -= batch.length;
            this.firstQueuedAt = this.options.queue.isEmpty() ? 0 : Date.now();
            this.pump();
        }
    }
    effectiveMaxBatchSize() {
        const scaled = Math.floor(this.options.maxBatchSize * this.options.healthMonitor.batchScale(this.options.route));
        return Math.max(1, scaled);
    }
    effectiveConcurrency() {
        const limit = this.options.connectionManager.maxForRoute(this.options.route);
        const scaled = Math.floor(limit * this.options.healthMonitor.concurrencyScale(this.options.route));
        return Math.max(1, scaled);
    }
    maxWaitElapsed() {
        if (!this.firstQueuedAt)
            return false;
        return Date.now() - this.firstQueuedAt >= this.effectiveMaxWaitMs();
    }
    effectiveMaxWaitMs(forceExtended = false) {
        const state = this.options.healthMonitor.snapshot(this.options.route).healthState;
        return forceExtended || state !== 'HEALTHY'
            ? this.options.maxWaitTimeMs * 2
            : this.options.maxWaitTimeMs;
    }
    ensureTimer(extended = false) {
        if (this.timer)
            return;
        const waitMs = this.effectiveMaxWaitMs(extended);
        this.timer = setTimeout(() => {
            this.timer = null;
            this.pump(true);
        }, waitMs);
        this.timer.unref?.();
    }
    clearTimer() {
        if (!this.timer)
            return;
        clearTimeout(this.timer);
        this.timer = null;
    }
    /**
     * Compute the JSON-encoded payload size for a batch.
     *
     * Returns a negative sentinel (-1) on serialization failure so callers can
     * distinguish "payload too large" from "payload not serializable" and
     * avoid re-serializing the same bad batch (which would double-count the
     * dropped events in stats).
     *
     * On serialization failure we drop the entire batch in one go and emit
     * a single onDrop notification with reason='serialization_failed'.
     */
    byteLength(events) {
        try {
            return Buffer.byteLength(JSON.stringify({ events, route: this.options.route, timestamp: Date.now() }));
        }
        catch {
            this.totalDropped += events.length;
            this.options.onDrop?.({
                route: this.options.route,
                reason: 'serialization_failed',
                count: events.length,
                eventType: events[0]?.type,
            });
            return -1;
        }
    }
}
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
