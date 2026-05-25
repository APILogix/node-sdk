/**
 * Batch processor — drains the event queue and sends events in batches.
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
import { type Logger } from '../utils/logger.js';
export interface BatcherOptions {
    batchSize?: number;
    flushIntervalMs?: number;
    logger?: Logger;
    maxConcurrentSends?: number;
}
/**
 * Start the batcher. Idempotent: re-running with new options applies them
 * without stacking timers.
 */
export declare function startBatcher(options?: BatcherOptions): void;
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
export declare function flush(): Promise<void>;
/**
 * Stop the batcher. Idempotent: safe to call multiple times.
 *
 * Resets all stateful subsystems (circuit breaker, rate limiter, memory
 * monitor) so a subsequent startBatcher() begins from a clean baseline.
 * This is critical for warm restarts: a stale OPEN circuit would otherwise
 * block the very first batch after re-init.
 */
export declare function stopBatcher(): void;
/** Get the current circuit breaker state for observability. */
export declare function getCircuitState(): string;
/** Force-reset the circuit breaker (for testing/recovery). */
export declare function resetCircuitBreaker(): void;
//# sourceMappingURL=batcher.d.ts.map