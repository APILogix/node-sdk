import { getLogger } from '../utils/logger.js';
import { TransportEventQueue } from './transport-event-queue.js';
import { ConnectionManager } from './connection-manager.js';
import { HealthMonitor } from './health-monitor.js';
import { context as otelContext } from '@opentelemetry/api';
import { suppressTracing } from '@opentelemetry/core';
import { SecurityScrubber } from '../processors/security-scrubber.js';
import { sanitizeEvent } from '../processors/sanitizer.js';
import { persistentStorage } from '../storage/persistent-storage.js';
import { persistenceGovernor } from '../storage/persistence-governor.js';
import { costGovernor } from '../utils/cost-governor.js';
import { compressGzip } from '../utils/compression.js';
import { inspectTelemetryResponse } from '../core/config-manager.js';
import { sdkConsoleDebug } from '../utils/console-debug.js';
export class BatchManager {
    options;
    timer = null;
    activeSends = 0;
    activeSendPromises = new Set();
    activeBatches = new Set();
    activeAbortControllers = new Set();
    handedOffEvents = new WeakSet();
    pendingRetryPromises = new Set();
    pendingRetryTimers = new Map();
    retryAttempts = new Map();
    batched = 0;
    totalSent = 0;
    totalDropped = 0;
    totalFailed = 0;
    totalRetries = 0;
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
        if (!accepted)
            return false;
        sdkConsoleDebug('batch enqueue', {
            route: this.options.route,
            eventType: event.type,
            eventId: event.eventId,
            queueSize: this.options.queue.size(),
            minBatchSize: this.options.minBatchSize,
            maxBatchSize: this.options.maxBatchSize,
        });
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
    /** Drain without event-loop polling; waits only on tracked work promises. */
    async flush() {
        this.clearTimer();
        const deadline = Date.now() + 4_000;
        const failedAtStart = this.totalFailed;
        const droppedAtStart = this.totalDropped;
        while (!this.options.queue.isEmpty() || this.activeSendPromises.size > 0 || this.pendingRetryPromises.size > 0) {
            this.pump(true);
            const work = [...this.activeSendPromises, ...this.pendingRetryPromises];
            if (work.length === 0)
                break;
            const remainingMs = deadline - Date.now();
            if (remainingMs <= 0)
                break;
            const completed = await settleWithin(work, remainingMs);
            if (!completed)
                break;
            const newFailures = (this.totalFailed - failedAtStart) + (this.totalDropped - droppedAtStart);
            if (newFailures >= Math.max(5, this.options.retry.maxRetries + 1))
                break;
        }
    }
    /**
     * Stop new work, cancel delayed retries, abort active requests, and return
     * any batches that could not be quiesced within the bounded wait. The
     * router persists returned events before dropping manager references.
     */
    async shutdown(timeoutMs = 4_000) {
        this.destroyed = true;
        this.clearTimer();
        this.cancelPendingRetries();
        for (const controller of this.activeAbortControllers)
            controller.abort();
        const completed = await settleWithin([...this.activeSendPromises], Math.max(1, timeoutMs));
        this.cancelPendingRetries();
        if (completed)
            return [];
        const residual = [...this.activeBatches].flatMap(events => [...events]);
        for (const event of residual)
            this.handedOffEvents.add(event);
        return residual;
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
            totalRetries: this.totalRetries,
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
            if (!batch)
                break;
            this.activeSends++;
            this.batched += batch.events.length;
            this.activeBatches.add(batch.events);
            const sendPromise = this.sendBatch(batch);
            this.activeSendPromises.add(sendPromise);
            void sendPromise.then(() => this.activeSendPromises.delete(sendPromise), error => {
                this.activeSendPromises.delete(sendPromise);
                getLogger().warn('[TransportRouter] Unhandled batch send failure', { route: this.options.route, error });
            });
        }
    }
    nextSerializableBatch() {
        const targetSize = this.effectiveMaxBatchSize();
        let batch = this.options.queue.drain(targetSize);
        while (batch.length > 0) {
            const scrubber = SecurityScrubber.getInstance();
            const safeBatch = scrubber ? scrubber.scrubBatch(batch) : batch.map(e => sanitizeEvent(e));
            const payload = { events: safeBatch, route: this.options.route, timestamp: Date.now() };
            let body;
            let payloadBytes;
            try {
                body = JSON.stringify(payload);
                payloadBytes = Buffer.byteLength(body);
            }
            catch {
                // Serialization failed (e.g., circular ref). Drop the entire batch in
                // one go and emit a single onDrop notification. Do not requeue — that
                // would re-serialize the same bad payload and double-count the drop.
                this.totalDropped += batch.length;
                this.options.onDrop?.({
                    route: this.options.route,
                    reason: 'serialization_failed',
                    count: batch.length,
                    eventType: batch[0]?.type,
                });
                return null;
            }
            if (payloadBytes <= this.options.maxPayloadBytes) {
                sdkConsoleDebug('batch built', {
                    route: this.options.route,
                    eventCount: safeBatch.length,
                    eventTypes: [...new Set(safeBatch.map(event => event.type))],
                    eventIds: safeBatch.slice(0, 10).map(event => event.eventId).filter(Boolean),
                    payloadBytes,
                    maxPayloadBytes: this.options.maxPayloadBytes,
                });
                return { events: safeBatch, body };
            }
            if (batch.length === 1) {
                this.totalDropped++;
                this.options.onDrop?.({
                    route: this.options.route,
                    reason: 'event_too_large',
                    count: 1,
                    eventType: batch[0]?.type,
                });
                return null;
            }
            const half = Math.max(1, Math.floor(batch.length / 2));
            const overflow = batch.splice(half);
            this.options.queue.requeueFront(overflow);
        }
        return null;
    }
    async sendBatch(batch) {
        const startedAt = Date.now();
        const { events, body } = batch;
        const lease = await this.options.connectionManager.acquire(this.options.route);
        if (!lease) {
            this.activeBatches.delete(events);
            this.activeSends--;
            this.batched -= events.length;
            this.totalFailed += events.length;
            // Connection-pool starvation is a transient failure (rate-limited or
            // socket-saturated). Persist so a process crash before the next pump
            // doesn't lose the batch, then re-queue for the next tick.
            this.persistOnFailure(events, 'connection_acquire_failed');
            this.retryOrRetain(events);
            return;
        }
        try {
            const rawBody = Buffer.from(body, 'utf8');
            const wireBody = await compressGzip(rawBody);
            const headers = {
                'Content-Type': this.options.definition.contentType,
                Authorization: `Bearer ${this.options.apiKey}`,
                'X-Route': this.options.route,
                'x-pulse-internal': '1',
                Connection: this.options.keepAlive ? 'keep-alive' : 'close',
                'Content-Encoding': 'gzip',
            };
            const controller = new AbortController();
            this.activeAbortControllers.add(controller);
            if (this.destroyed)
                controller.abort();
            const timeout = setTimeout(() => controller.abort(), this.options.socketTimeoutMs);
            timeout.unref?.();
            try {
                const requestBody = new ArrayBuffer(wireBody.byteLength);
                new Uint8Array(requestBody).set(wireBody);
                getLogger().info('[TransportRouter] Sending batch', {
                    route: this.options.route,
                    url: this.options.definition.url,
                    method: this.options.definition.method,
                    eventCount: events.length,
                    eventTypes: [...new Set(events.map(event => event.type))],
                    eventIds: events.slice(0, 5).map(event => event.eventId).filter(Boolean),
                    compression: 'gzip',
                    configuredCompression: this.options.compression,
                    originalBytes: rawBody.length,
                    compressedBytes: wireBody.length,
                });
                logTransportConsole('request', {
                    route: this.options.route,
                    url: this.options.definition.url,
                    method: this.options.definition.method,
                    eventCount: events.length,
                    eventTypes: [...new Set(events.map(event => event.type))],
                    eventIds: events.slice(0, 5).map(event => event.eventId).filter(Boolean),
                    headers: {
                        'Content-Type': headers['Content-Type'],
                        Authorization: 'Bearer [redacted]',
                        'X-Route': headers['X-Route'],
                        'x-pulse-internal': headers['x-pulse-internal'],
                        Connection: headers['Connection'],
                        'Content-Encoding': headers['Content-Encoding'],
                    },
                    compression: 'gzip',
                    originalBytes: rawBody.length,
                    compressedBytes: wireBody.length,
                });
                sdkConsoleDebug('batch send request', {
                    route: this.options.route,
                    url: this.options.definition.url,
                    method: this.options.definition.method,
                    eventCount: events.length,
                    eventTypes: [...new Set(events.map(event => event.type))],
                    eventIds: events.slice(0, 10).map(event => event.eventId).filter(Boolean),
                    headers: {
                        'Content-Type': headers['Content-Type'],
                        Authorization: 'Bearer [redacted]',
                        'X-Route': headers['X-Route'],
                        'x-pulse-internal': headers['x-pulse-internal'],
                        Connection: headers['Connection'],
                        'Content-Encoding': headers['Content-Encoding'],
                    },
                    compression: 'gzip',
                    originalBytes: rawBody.length,
                    compressedBytes: wireBody.length,
                });
                // suppressTracing prevents OTel HttpInstrumentation from creating a
                // span for our own batch send. Without this, every export of N
                // events produces N+1 spans, which themselves export, causing
                // unbounded fan-out. The static URL ignore list in
                // auto-instrument.ts is defense-in-depth for the same problem.
                const response = await otelContext.with(suppressTracing(otelContext.active()), () => this.fetchImpl(this.options.definition.url, {
                    method: this.options.definition.method,
                    headers,
                    body: requestBody,
                    signal: controller.signal,
                    // Never forward the bearer token to a redirected origin.
                    redirect: 'manual',
                }));
                const latency = Date.now() - startedAt;
                logTransportConsole('response', {
                    route: this.options.route,
                    url: this.options.definition.url,
                    statusCode: response.status,
                    ok: response.ok,
                    latencyMs: latency,
                    eventCount: events.length,
                    contentType: response.headers.get('content-type') ?? undefined,
                });
                sdkConsoleDebug('batch send response', {
                    route: this.options.route,
                    url: this.options.definition.url,
                    statusCode: response.status,
                    ok: response.ok,
                    latencyMs: latency,
                    eventCount: events.length,
                    contentType: response.headers.get('content-type') ?? undefined,
                });
                if (response.ok) {
                    this.options.healthMonitor.recordSuccess(this.options.route, latency);
                    this.totalSent += events.length;
                    this.totalRequests++;
                    this.totalBatchEvents += events.length;
                    for (const event of events)
                        this.retryAttempts.delete(event.eventId ?? '');
                    // Feed the cost governor's bytes budget with the uncompressed
                    // payload size — ingestion billing is per event byte, not per
                    // compressed wire byte. Without this, shouldReduceTelemetry()
                    // could never engage and getStats() always reported 0 bytes.
                    costGovernor.recordBytesSent(Buffer.byteLength(body));
                    // ACK: backend confirmed delivery. Remove the batch from disk if
                    // it had been persisted on a previous failed attempt. discard()
                    // is async (it rewrites the NDJSON file) but we do not await it
                    // here — the send pipeline must not block on filesystem latency.
                    // The write chain inside persistentStorage serializes discards
                    // safely.
                    this.discardOnSuccess(events);
                    // The telemetry ACK is fully accounted for before config refresh is
                    // considered. Inspection is non-blocking and ConfigManager enforces
                    // single-flight refreshes.
                    inspectTelemetryResponse(response);
                }
                else if (response.status >= 500 || response.status === 429 || response.status === 408) {
                    const responseBody = await readResponseSnippet(response);
                    getLogger().warn('[TransportRouter] Retryable batch response', {
                        route: this.options.route,
                        url: this.options.definition.url,
                        statusCode: response.status,
                        eventCount: events.length,
                        responseBody,
                    });
                    this.options.healthMonitor.recordFailure(this.options.route);
                    this.totalFailed += events.length;
                    // Retry-eligible failure: persist before re-queue so a crash
                    // between now and the next attempt doesn't lose the batch.
                    this.persistOnFailure(events, `http_${response.status}`);
                    this.retryOrRetain(events);
                }
                else {
                    const responseBody = await readResponseSnippet(response);
                    getLogger().warn('[TransportRouter] Non-retryable batch response', {
                        route: this.options.route,
                        url: this.options.definition.url,
                        statusCode: response.status,
                        eventCount: events.length,
                        responseBody,
                    });
                    this.options.healthMonitor.recordFailure(this.options.route);
                    this.totalDropped += events.length;
                    for (const event of events)
                        this.retryAttempts.delete(event.eventId ?? '');
                    // Non-retryable failure (4xx other than 408/429). The backend
                    // has rejected the batch and a retry would just be re-rejected.
                    // Do NOT persist — replaying a permanent rejection forever is a
                    // bug. Drop the batch and notify the dropper.
                    this.options.onDrop?.({
                        route: this.options.route,
                        reason: 'route_unavailable',
                        count: events.length,
                        eventType: events[0]?.type,
                    });
                }
            }
            finally {
                clearTimeout(timeout);
                this.activeAbortControllers.delete(controller);
            }
        }
        catch (error) {
            this.options.healthMonitor.recordFailure(this.options.route);
            this.totalFailed += events.length;
            // Network-level failure (DNS, TCP reset, abort, fetch rejection).
            // The backend never saw the request, so retry is safe. Persist so a
            // crash before retry doesn't drop the batch.
            this.persistOnFailure(events, 'network_error');
            this.retryOrRetain(events);
            getLogger().warn('[TransportRouter] Batch send failed', {
                route: this.options.route,
                url: this.options.definition.url,
                error: error instanceof Error ? error.message : String(error),
                eventCount: events.length,
            });
        }
        finally {
            this.activeBatches.delete(events);
            lease.release(true);
            this.activeSends--;
            this.batched -= events.length;
            this.firstQueuedAt = this.options.queue.isEmpty() ? 0 : Date.now();
            this.pump();
        }
    }
    retryOrRetain(events) {
        if (this.destroyed) {
            const retained = events.filter(event => !this.handedOffEvents.has(event));
            this.options.queue.requeueFront(retained);
            for (const event of events)
                this.retryAttempts.delete(event.eventId ?? '');
            return;
        }
        if (!this.options.retry.enabled || this.options.retry.maxRetries <= 0)
            return;
        const retryable = [];
        let highestAttempt = 0;
        for (const event of events) {
            const key = event.eventId ?? '';
            const attempt = (this.retryAttempts.get(key) ?? 0) + 1;
            if (attempt > this.options.retry.maxRetries) {
                this.retryAttempts.delete(key);
                continue;
            }
            this.retryAttempts.set(key, attempt);
            highestAttempt = Math.max(highestAttempt, attempt);
            retryable.push(event);
        }
        if (retryable.length === 0)
            return;
        this.totalRetries += retryable.length;
        const delayMs = retryDelay(this.options.retry, highestAttempt);
        let resolveRetry;
        const pending = new Promise(resolve => { resolveRetry = resolve; });
        this.pendingRetryPromises.add(pending);
        const timer = setTimeout(() => {
            this.pendingRetryTimers.delete(timer);
            this.pendingRetryPromises.delete(pending);
            this.options.queue.requeueFront(retryable);
            if (!this.destroyed)
                this.ensureTimer(true);
            resolveRetry();
        }, delayMs);
        timer.unref?.();
        this.pendingRetryTimers.set(timer, { events: retryable, resolve: resolveRetry });
    }
    cancelPendingRetries() {
        for (const [timer, pending] of this.pendingRetryTimers) {
            clearTimeout(timer);
            this.options.queue.requeueFront(pending.events);
            pending.resolve();
        }
        this.pendingRetryTimers.clear();
        this.pendingRetryPromises.clear();
    }
    /**
     * Persist a batch to disk after a transient send failure.
     *
     * Called on network errors, retry-eligible HTTP failures (5xx, 429, 408),
     * and connection-acquisition starvation. NOT called on 4xx permanent
     * rejections — those are dropped because replaying them forever is a bug.
     *
     * Persistence is best-effort and never throws to the caller. The batch
     * is still re-queued in memory by the caller; persistence is purely
     * defense against process crash before the in-memory retry succeeds.
     */
    persistOnFailure(batch, reason) {
        try {
            if (!persistentStorage.isInitialized)
                return;
            // Consult the persistence governor per event: critical-tier events
            // (errors/crashes) always persist, but under adaptive pressure the
            // governor sheds lower durability tiers and enforces the per-minute
            // persist budget — so a failing backend can't turn into a disk-I/O
            // storm exactly when the process is already under memory/GC pressure.
            const survivable = batch.filter(event => persistenceGovernor.shouldPersist(event));
            if (survivable.length > 0) {
                persistentStorage.persistBatch(survivable);
            }
        }
        catch (error) {
            // Persistence failure on the failure path is genuinely best-effort.
            // We've already counted the batch as failed; logging here is enough.
            getLogger().debug('[TransportRouter] Failed to persist failed batch', {
                route: this.options.route,
                reason,
                eventCount: batch.length,
                error,
            });
        }
    }
    /**
     * Discard delivered events from durable storage after backend ACK.
     *
     * Fire-and-forget: the rewrite is serialized through the storage write
     * chain, so completion order is correct, but we do not await here so a
     * slow filesystem cannot block the send pipeline. A crash before the
     * discard write hits disk leaves the events on disk and produces a
     * single duplicate replay on the next start — which the backend MUST
     * dedupe by `eventId` per the at-least-once delivery contract.
     */
    discardOnSuccess(batch) {
        if (!persistentStorage.isInitialized)
            return;
        void persistentStorage.discard(batch).catch(error => {
            getLogger().debug('[TransportRouter] Failed to discard delivered batch', {
                route: this.options.route,
                eventCount: batch.length,
                error,
            });
        });
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
            otelContext.with(suppressTracing(otelContext.active()), () => {
                this.pump(true);
            });
        }, waitMs);
        this.timer.unref?.();
    }
    clearTimer() {
        if (!this.timer)
            return;
        clearTimeout(this.timer);
        this.timer = null;
    }
}
async function settleWithin(promises, timeoutMs) {
    let timer;
    try {
        return await Promise.race([
            Promise.allSettled(promises).then(() => true),
            new Promise(resolve => {
                timer = setTimeout(() => resolve(false), timeoutMs);
                timer.unref?.();
            }),
        ]);
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
}
async function readResponseSnippet(response) {
    try {
        const text = await response.clone().text();
        if (!text)
            return undefined;
        return text.length > 500 ? `${text.slice(0, 500)}...` : text;
    }
    catch {
        return undefined;
    }
}
function logTransportConsole(direction, details) {
    if (process.env['PULSE_TRANSPORT_CONSOLE'] !== 'true')
        return;
    console.log(`[Pulse SDK ${direction === 'request' ? '->' : '<-'} backend] ${direction}`, details);
}
function retryDelay(config, attempt) {
    const base = Math.max(0, config.baseDelayMs);
    if (config.backoff === 'fixed')
        return base;
    if (config.backoff === 'linear')
        return Math.min(30_000, base * attempt);
    return Math.min(30_000, base * 2 ** Math.max(0, attempt - 1));
}
