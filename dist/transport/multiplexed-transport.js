import { postJson } from './http.js';
import { getLogger } from '../utils/logger.js';
import { SDK_VERSION } from '../constants/version.js';
import { epochMs } from '../utils/time.js';
import { SecurityScrubber } from '../processors/security-scrubber.js';
import { sanitizeEvent } from '../processors/sanitizer.js';
export class MultiplexedTransport {
    baseUrl;
    apiKey;
    flushIntervalMs;
    flushTimer = null;
    pendingBatches = new Map();
    destroyed = false;
    flushing = false;
    constructor(baseUrl, apiKey, flushIntervalMs = 2000) {
        this.baseUrl = baseUrl;
        this.apiKey = apiKey;
        this.flushIntervalMs = flushIntervalMs;
        this.flushTimer = setInterval(() => void this.flush(), this.flushIntervalMs);
        if (this.flushTimer.unref)
            this.flushTimer.unref();
    }
    enqueue(route, events) {
        if (this.destroyed)
            return;
        const existing = this.pendingBatches.get(route) || [];
        existing.push(...events);
        this.pendingBatches.set(route, existing);
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
            this.pendingBatches.clear();
            if (batches.length === 0)
                return;
            const payload = {
                batches,
                timestamp: epochMs(),
                sdk: SDK_VERSION
            };
            await postJson(`${this.baseUrl}/v1/ingest`, payload, {
                Authorization: `Bearer ${this.apiKey}`
            }, 30000);
        }
        catch (err) {
            getLogger().error('Failed to flush multiplexed transport', { error: err });
        }
        finally {
            this.flushing = false;
        }
    }
    async shutdown() {
        if (this.destroyed)
            return;
        this.destroyed = true;
        if (this.flushTimer) {
            clearInterval(this.flushTimer);
            this.flushTimer = null;
        }
        await this.flush();
    }
    isEnabled() {
        return !this.destroyed;
    }
}
//# sourceMappingURL=multiplexed-transport.js.map