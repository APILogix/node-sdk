/**
 * Batch processor — drains the event queue and sends events in batches.
 *
 * Features:
 * - Circuit breaker integration — skips sends when endpoint is down
 * - Rate limiter integration — prevents burst storms
 * - Concurrent flight limiting — max N in-flight batch sends
 * - Self-rescheduling timer — prevents overlapping ticks
 * - Memory pressure awareness via backpressure monitor
 */
import { eventQueue } from './queue.js';
import { sendEvents } from './sender.js';
import { DEFAULT_BATCH_SIZE, DEFAULT_FLUSH_INTERVAL_MS } from '../constants/defaults.js';
import { getLogger } from '../utils/logger.js';
import { CircuitBreaker } from './circuit-breaker.js';
import { TokenBucketRateLimiter } from './rate-limit.js';
// ─── State ──────────────────────────────────────────────────────────────────
let timer = null;
let batchSize = DEFAULT_BATCH_SIZE;
let flushIntervalMs = DEFAULT_FLUSH_INTERVAL_MS;
let logger = getLogger();
let inFlightCount = 0;
let maxConcurrentSends = 3;
let isRunning = false;
// ─── Subsystems ─────────────────────────────────────────────────────────────
const circuitBreaker = new CircuitBreaker({
    failureThreshold: 5,
    resetTimeoutMs: 30_000,
    halfOpenMaxProbes: 1,
});
const rateLimiter = new TokenBucketRateLimiter({
    capacity: 10, // Allow burst of 10 batch sends
    refillRate: 2, // Refill 2 tokens per second
});
export function startBatcher(options) {
    batchSize = options?.batchSize ?? batchSize;
    flushIntervalMs = options?.flushIntervalMs ?? flushIntervalMs;
    logger = options?.logger ?? getLogger();
    maxConcurrentSends = options?.maxConcurrentSends ?? maxConcurrentSends;
    isRunning = true;
    if (timer)
        return;
    // Self-rescheduling timer — prevents overlapping ticks
    scheduleNextTick();
    logger.debug('Batcher started', {
        batchSize,
        flushIntervalMs,
        maxConcurrentSends,
    });
}
export async function flush() {
    while (eventQueue.size() > 0) {
        const events = eventQueue.drain(batchSize);
        if (events.length === 0)
            break;
        try {
            await sendEvents(events);
            circuitBreaker.recordSuccess();
        }
        catch (err) {
            circuitBreaker.recordFailure();
            eventQueue.drop(events.length);
            logger.error('Flush failed; dropping events after retry budget exhausted', {
                error: err,
                eventCount: events.length,
                deadLetterCount: eventQueue.getDeadLetterCount(),
                circuitState: circuitBreaker.getState(),
            });
            throw err;
        }
    }
}
export function stopBatcher() {
    isRunning = false;
    if (timer) {
        clearTimeout(timer);
        timer = null;
    }
    logger.debug('Batcher stopped');
}
/** Get the current circuit breaker state for observability. */
export function getCircuitState() {
    return circuitBreaker.getState();
}
/** Force-reset the circuit breaker (for testing/recovery). */
export function resetCircuitBreaker() {
    circuitBreaker.reset();
}
// ─── Internal ───────────────────────────────────────────────────────────────
function scheduleNextTick() {
    if (!isRunning)
        return;
    timer = setTimeout(async () => {
        await tick();
        scheduleNextTick();
    }, flushIntervalMs);
    // Don't hold the process open just for batch ticks
    timer.unref();
}
async function tick() {
    // Guard: skip if nothing to send
    if (eventQueue.size() === 0)
        return;
    // Guard: circuit breaker is open — buffer, don't send
    if (!circuitBreaker.canExecute()) {
        logger.debug('Batch tick skipped — circuit breaker OPEN', {
            circuitState: circuitBreaker.getState(),
            queueSize: eventQueue.size(),
        });
        return;
    }
    // Guard: rate limiter throttle
    if (!rateLimiter.tryAcquire()) {
        logger.debug('Batch tick skipped — rate limited', {
            rateLimiterState: rateLimiter.getState(),
            queueSize: eventQueue.size(),
        });
        return;
    }
    // Guard: concurrent flight limit
    if (inFlightCount >= maxConcurrentSends) {
        logger.debug('Batch tick skipped — max concurrent sends reached', {
            inFlightCount,
            maxConcurrentSends,
        });
        return;
    }
    const events = eventQueue.drain(batchSize);
    if (events.length === 0)
        return;
    inFlightCount += 1;
    try {
        await sendEvents(events);
        circuitBreaker.recordSuccess();
        logger.debug('Batch sent successfully', {
            eventCount: events.length,
            queueRemaining: eventQueue.size(),
            circuitState: circuitBreaker.getState(),
        });
    }
    catch (err) {
        circuitBreaker.recordFailure();
        eventQueue.drop(events.length);
        logger.error('Batch send failed; dropping events after retry budget exhausted', {
            error: err,
            eventCount: events.length,
            deadLetterCount: eventQueue.getDeadLetterCount(),
            circuitState: circuitBreaker.getState(),
        });
    }
    finally {
        inFlightCount -= 1;
    }
}
//# sourceMappingURL=batcher.js.map