import { postJson } from './http.js';
import { getLogger } from '../utils/logger.js';
import { SDK_VERSION } from '../constants/version.js';
import { epochMs } from '../utils/time.js';
import { SecurityScrubber } from '../processors/security-scrubber.js';
import { sanitizeEvent } from '../processors/sanitizer.js';
import { compressGzip } from '../utils/compression.js';
/**
 * Hard bound on buffered events per route. Without it a permanently
 * unreachable ingest endpoint grows `pendingBatches` without limit and
 * OOMs the host process. Overflow drops the oldest events (head of the
 * array) so the most recent telemetry is preserved.
 */
const MAX_PENDING_EVENTS_PER_ROUTE = 10_000;
/**
 * Routes whose events flush immediately instead of waiting for the next
 * interval tick. Cron check-ins are time-sensitive (a 2s delay defeats
 * timeout detection) and errors are the highest-signal telemetry we ship.
 */
const IMMEDIATE_FLUSH_ROUTES = new Set(['crons', 'errors']);
export class MultiplexedTransport {
    baseUrl;
    apiKey;
    flushIntervalMs;
    flushTimer = null;
    pendingBatches = new Map();
    destroyed = false;
    flushing = false;
    constructor(baseUrl, apiKey, flushIntervalMs) {
        this.baseUrl = baseUrl;
        this.apiKey = apiKey;
        this.flushIntervalMs = flushIntervalMs ?? 2000;
        this.flushTimer = setInterval(() => void this.flush(), this.flushIntervalMs);
        if (this.flushTimer.unref)
            this.flushTimer.unref();
    }
    enqueue(route, events) {
        if (this.destroyed)
            return;
        const existing = this.pendingBatches.get(route) || [];
        existing.push(...events);
        // Bound the buffer — drop oldest on overflow.
        if (existing.length > MAX_PENDING_EVENTS_PER_ROUTE) {
            const overflow = existing.length - MAX_PENDING_EVENTS_PER_ROUTE;
            existing.splice(0, overflow);
            getLogger().warn('[MultiplexedTransport] Pending buffer full, dropped oldest events', {
                route,
                dropped: overflow,
            });
        }
        this.pendingBatches.set(route, existing);
        // Time-sensitive routes bypass the flush interval.
        if (IMMEDIATE_FLUSH_ROUTES.has(route)) {
            void this.flush();
        }
    }
    async flush() {
        if (this.destroyed || this.flushing || this.pendingBatches.size === 0)
            return;
        this.flushing = true;
        try {
            const scrubber = SecurityScrubber.getInstance();
            const batches = [];
            for (const [route, events] of this.pendingBatches.entries()) {
                if (events.length > 0) {
                    let safeEvents = events;
                    if (scrubber) {
                        safeEvents = scrubber.scrubBatch(safeEvents);
                    }
                    else {
                        safeEvents = safeEvents.map(e => sanitizeEvent(e));
                    }
                    batches.push({ route, events: safeEvents });
                }
            }
            if (batches.length === 0)
                return;
            const payload = {
                batches,
                timestamp: epochMs(),
                sdk: SDK_VERSION
            };
            // Every batch is gzip-compressed before it leaves the process. This
            // is an SDK-level transport contract, NOT a remote-config knob.
            const compressedBody = await compressGzip(Buffer.from(JSON.stringify(payload), 'utf8'));
            try {
                await postJson(`${this.baseUrl}/v1/ingest`, compressedBody, {
                    Authorization: `Bearer ${this.apiKey}`,
                    'Content-Encoding': 'gzip',
                }, 30000);
                // Only now is it safe to drop the buffered events: the backend has
                // acknowledged the batch. Clearing before the send (the old
                // behaviour) lost every in-flight batch on network failure.
                this.pendingBatches.clear();
            }
            catch (err) {
                // Send failed — the events stay buffered for the next tick. The
                // per-route bound in enqueue() keeps memory flat in a sustained
                // outage.
                getLogger().error('Failed to flush multiplexed transport', { error: err });
            }
        }
        finally {
            this.flushing = false;
        }
    }
    async shutdown() {
        if (this.destroyed)
            return;
        if (this.flushTimer) {
            clearInterval(this.flushTimer);
            this.flushTimer = null;
        }
        // Final flush BEFORE setting destroyed — flush() early-returns once the
        // destroyed flag is set, which previously dropped every buffered event
        // at shutdown.
        await this.flush();
        this.destroyed = true;
    }
    isEnabled() {
        return !this.destroyed;
    }
}
//# sourceMappingURL=multiplexed-transport.js.map