/**
 * Batch processor — drains the event queue and sends events in batches.
 *
 * @deprecated DORMANT LEGACY PATH. `startBatcher()` has no call sites: the
 * active transport pipeline is `TransportRouter` + `BatchManager`
 * (per-route queues, health-aware batching, connection leasing). This module
 * is retained only so the lifecycle's unconditional cleanup can call the
 * idempotent `stopBatcher()` to reset its circuit breaker / rate limiter /
 * pressure monitor on shutdown-reinit cycles. Do not add new call sites;
 * the module is scheduled for removal in the next major release.
 *
 * Lifecycle guarantees:
 * - startBatcher() is idempotent: a second call without an intervening stop
 *   reconfigures parameters but does NOT stack timers.
 * - stopBatcher() is idempotent: clearing an already-cleared timer is safe.
 * - On stop, every stateful subsystem (circuit breaker, rate limiter,
 *   memory pressure monitor) is reset so a subsequent start begins from a
 *   clean baseline. This prevents stale OPEN circuits or empty token
 *   buckets from blocking the next batcher cycle on warm restart.
 *
 * Concurrency guarantees:
 * - flush() takes a single-flight lock — concurrent flush calls (e.g.,
 *   shutdown + signal handler racing) share one in-flight drain.
 * - tick() and flush() never run drain operations in parallel.
 */
import { eventQueue } from './queue.js';
import { sendEvents } from './sender.js';
import { DEFAULT_BATCH_SIZE, DEFAULT_FLUSH_INTERVAL_MS } from '../constants/defaults.js';
import { getLogger } from '../utils/logger.js';
import { CircuitBreaker } from './circuit-breaker.js';
import { TokenBucketRateLimiter } from './rate-limit.js';
import { MemoryPressureMonitor } from '../utils/backpressure.js';
import { client } from '../core/client.js';
import { persistentStorage } from '../storage/persistent-storage.js';
import { drainPendingEventProcessing } from '../core/event-pipeline.js';
// ─── Module State ───────────────────────────────────────────────────────────
let timer = null;
let batchSize = DEFAULT_BATCH_SIZE;
let flushIntervalMs = DEFAULT_FLUSH_INTERVAL_MS;
let logger = getLogger();
let inFlightCount = 0;
let maxConcurrentSends = 3;
let isRunning = false;
let inFlightFlush = null;
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
const memoryMonitor = new MemoryPressureMonitor({
    elevatedThreshold: 0.7,
    criticalThreshold: 0.9,
    pollIntervalMs: 5000,
});
/**
 * Start the batcher. Idempotent: re-running with new options applies them
 * without stacking timers.
 */
export function startBatcher(options) {
    batchSize = options?.batchSize ?? batchSize;
    flushIntervalMs = options?.flushIntervalMs ?? flushIntervalMs;
    logger = options?.logger ?? getLogger();
    maxConcurrentSends = options?.maxConcurrentSends ?? maxConcurrentSends;
    // Idempotent: an existing timer means the batcher is already running.
    // We've already updated parameters above so the next tick uses them.
    if (isRunning && timer) {
        logger.debug('Batcher already running, parameters updated', {
            batchSize,
            flushIntervalMs,
            maxConcurrentSends,
        });
        return;
    }
    isRunning = true;
    memoryMonitor.start();
    scheduleNextTick();
    logger.debug('Batcher started', {
        batchSize,
        flushIntervalMs,
        maxConcurrentSends,
    });
}
/**
 * Force-flush the queue.
 * Concurrent calls share a single in-flight flush — this prevents two
 * shutdown paths (e.g., user-initiated + signal handler) from double-sending
 * the same events.
 *
 * If retry attempts are exhausted with events still queued, the residual
 * events are persisted to disk before returning so a subsequent crash
 * cannot lose them.
 */
export async function flush() {
    if (inFlightFlush) {
        return inFlightFlush;
    }
    inFlightFlush = (async () => {
        const MAX_FLUSH_ATTEMPTS = 3;
        let attempts = 0;
        await drainPendingEventProcessing();
        while (eventQueue.size() > 0) {
            if (attempts >= MAX_FLUSH_ATTEMPTS) {
                // Retry budget exhausted. Drain remaining events out of the in-memory
                // queue and persist them to disk so they survive a process crash.
                // The replay path on the next init will pick them up.
                const remaining = eventQueue.drainAll();
                for (const event of remaining) {
                    persistentStorage.persist(event);
                }
                logger.warn('Flush max attempts reached — persisted remaining events to disk', {
                    remainingEvents: remaining.length,
                    maxFlushAttempts: MAX_FLUSH_ATTEMPTS,
                });
                break;
            }
            const events = eventQueue.drain(batchSize);
            if (events.length === 0)
                break;
            try {
                await sendEvents(events);
                await persistentStorage.discard(events);
                circuitBreaker.recordSuccess();
                logger.info('Flush sent successfully', { eventCount: events.length });
            }
            catch (err) {
                circuitBreaker.recordFailure();
                for (const event of events) {
                    persistentStorage.persist(event);
                }
                // Re-queue events after persistence so retry pressure can spill safely.
                eventQueue.requeueFront(events);
                logger.error('Flush failed; events re-queued', {
                    error: err instanceof Error ? err.message : String(err),
                    eventCount: events.length,
                    queueSize: eventQueue.size(),
                    circuitState: circuitBreaker.getState(),
                    flushAttempt: attempts + 1,
                });
                attempts += 1;
            }
        }
        await persistentStorage.flush();
    })().finally(() => {
        inFlightFlush = null;
    });
    return inFlightFlush;
}
/**
 * Stop the batcher. Idempotent: safe to call multiple times.
 *
 * Resets all stateful subsystems (circuit breaker, rate limiter, memory
 * monitor) so a subsequent startBatcher() begins from a clean baseline.
 * This is critical for warm restarts: a stale OPEN circuit would otherwise
 * block the very first batch after re-init.
 */
export function stopBatcher() {
    if (!isRunning && !timer)
        return;
    isRunning = false;
    if (timer) {
        clearTimeout(timer);
        timer = null;
    }
    // Stop polling memory pressure (frees the 5s interval timer).
    memoryMonitor.stop();
    // Reset stateful subsystems to prevent carry-over on reinit.
    inFlightCount = 0;
    circuitBreaker.reset();
    rateLimiter.reset();
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
        timer = null;
        try {
            await tick();
        }
        catch (err) {
            // Prevent unhandled rejection from silently killing the batcher.
            logger.error('Batch tick failed unexpectedly', { error: err });
        }
        if (isRunning)
            scheduleNextTick();
    }, flushIntervalMs);
    // Don't hold the process open just for batch ticks.
    timer.unref();
}
async function tick() {
    // Guard: skip if nothing to send
    if (eventQueue.size() === 0)
        return;
    // Guard: SDK must be initialized before sending
    if (!client.initialized) {
        logger.debug('Batch tick skipped — SDK not yet initialized', {
            queueSize: eventQueue.size(),
        });
        return;
    }
    // Guard: memory pressure — degrade gracefully under heap pressure
    const pressure = memoryMonitor.getState();
    if (pressure.level === 'critical') {
        logger.warn('Batch tick skipped — critical memory pressure', {
            heapUsedMb: pressure.heapUsedMb,
            heapTotalMb: pressure.heapTotalMb,
            heapUtilization: pressure.heapUtilization.toFixed(2),
            queueSize: eventQueue.size(),
        });
        return;
    }
    // Guard: circuit breaker is open — buffer, don't send
    if (!circuitBreaker.canExecute()) {
        logger.warn('Batch tick skipped — circuit breaker OPEN (will auto-reset after timeout)', {
            circuitState: circuitBreaker.getState(),
            queueSize: eventQueue.size(),
        });
        return;
    }
    // Guard: rate limiter throttle
    if (!rateLimiter.tryAcquire()) {
        logger.warn('Batch tick skipped — rate limited', {
            queueSize: eventQueue.size(),
        });
        return;
    }
    // Guard: concurrent flight limit
    if (inFlightCount >= maxConcurrentSends) {
        logger.warn('Batch tick skipped — max concurrent sends reached', {
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
        await persistentStorage.discard(events);
        circuitBreaker.recordSuccess();
        logger.info('Batch sent successfully', {
            eventCount: events.length,
            queueRemaining: eventQueue.size(),
            circuitState: circuitBreaker.getState(),
        });
    }
    catch (err) {
        circuitBreaker.recordFailure();
        for (const event of events) {
            persistentStorage.persist(event);
        }
        // Re-queue events after persistence so retry pressure can spill safely.
        eventQueue.requeueFront(events);
        const cbState = circuitBreaker.getState();
        logger.error('Batch send failed; events re-queued', {
            error: err instanceof Error ? err.message : String(err),
            eventCount: events.length,
            queueSize: eventQueue.size(),
            circuitState: cbState,
            willSkipFutureBatches: cbState === 'OPEN',
        });
    }
    finally {
        inFlightCount -= 1;
    }
}
