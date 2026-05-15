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
import { type Logger } from '../utils/logger.js';
export interface BatcherOptions {
    batchSize?: number;
    flushIntervalMs?: number;
    logger?: Logger;
    maxConcurrentSends?: number;
}
export declare function startBatcher(options?: BatcherOptions): void;
export declare function flush(): Promise<void>;
export declare function stopBatcher(): void;
/** Get the current circuit breaker state for observability. */
export declare function getCircuitState(): string;
/** Force-reset the circuit breaker (for testing/recovery). */
export declare function resetCircuitBreaker(): void;
//# sourceMappingURL=batcher.d.ts.map