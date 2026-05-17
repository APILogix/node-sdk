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

import { eventQueue } from './queue.js'
import { sendEvents } from './sender.js'
import { DEFAULT_BATCH_SIZE, DEFAULT_FLUSH_INTERVAL_MS } from '../constants/defaults.js'
import { getLogger, type Logger } from '../utils/logger.js'
import { CircuitBreaker } from './circuit-breaker.js'
import { TokenBucketRateLimiter } from './rate-limit.js'
import { MemoryPressureMonitor } from '../utils/backpressure.js'
import { client } from '../core/client.js'

// ─── State ──────────────────────────────────────────────────────────────────

let timer: NodeJS.Timeout | null = null
let batchSize = DEFAULT_BATCH_SIZE
let flushIntervalMs = DEFAULT_FLUSH_INTERVAL_MS
let logger: Logger = getLogger()
let inFlightCount = 0
let maxConcurrentSends = 3
let isRunning = false

// ─── Subsystems ─────────────────────────────────────────────────────────────

const circuitBreaker = new CircuitBreaker({
  failureThreshold: 5,
  resetTimeoutMs: 30_000,
  halfOpenMaxProbes: 1,
})

const rateLimiter = new TokenBucketRateLimiter({
  capacity: 10,      // Allow burst of 10 batch sends
  refillRate: 2,     // Refill 2 tokens per second
})

const memoryMonitor = new MemoryPressureMonitor({
  elevatedThreshold: 0.7,
  criticalThreshold: 0.9,
  pollIntervalMs: 5000,
})

// ─── Public API ─────────────────────────────────────────────────────────────

export interface BatcherOptions {
  batchSize?: number
  flushIntervalMs?: number
  logger?: Logger
  maxConcurrentSends?: number
}

export function startBatcher(options?: BatcherOptions): void {
  batchSize = options?.batchSize ?? batchSize
  flushIntervalMs = options?.flushIntervalMs ?? flushIntervalMs
  logger = options?.logger ?? getLogger()
  maxConcurrentSends = options?.maxConcurrentSends ?? maxConcurrentSends
  isRunning = true

  if (timer) return

  // Start memory pressure monitoring
  memoryMonitor.start()

  // Self-rescheduling timer — prevents overlapping ticks
  scheduleNextTick()

  logger.debug('Batcher started', {
    batchSize,
    flushIntervalMs,
    maxConcurrentSends,
  })
}

export async function flush(): Promise<void> {
  const MAX_FLUSH_ATTEMPTS = 3
  let attempts = 0

  while (eventQueue.size() > 0) {
    if (attempts >= MAX_FLUSH_ATTEMPTS) {
      logger.warn('Flush max attempts reached — remaining events left in queue for next tick', {
        remainingEvents: eventQueue.size(),
        maxFlushAttempts: MAX_FLUSH_ATTEMPTS,
      })
      break
    }

    const events = eventQueue.drain(batchSize)
    if (events.length === 0) break

    try {
      await sendEvents(events)
      circuitBreaker.recordSuccess()
      logger.info('Flush sent successfully', { eventCount: events.length })
    } catch (err) {
      circuitBreaker.recordFailure()
      // Re-queue events instead of permanently dropping them
      eventQueue.requeueFront(events)
      logger.error('Flush failed; events re-queued', {
        error: err instanceof Error ? err.message : String(err),
        eventCount: events.length,
        queueSize: eventQueue.size(),
        circuitState: circuitBreaker.getState(),
        flushAttempt: attempts + 1,
      })
      attempts += 1
    }
  }
}

export function stopBatcher(): void {
  isRunning = false
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  // Stop memory pressure monitoring
  memoryMonitor.stop()
  // Reset all stateful subsystems to prevent stale state on reinit
  inFlightCount = 0
  circuitBreaker.reset()
  rateLimiter.reset()
  logger.debug('Batcher stopped')
}

/** Get the current circuit breaker state for observability. */
export function getCircuitState(): string {
  return circuitBreaker.getState()
}

/** Force-reset the circuit breaker (for testing/recovery). */
export function resetCircuitBreaker(): void {
  circuitBreaker.reset()
}

// ─── Internal ───────────────────────────────────────────────────────────────

function scheduleNextTick(): void {
  if (!isRunning) return

  timer = setTimeout(async () => {
    try {
      await tick()
    } catch (err) {
      // Prevent unhandled rejection from silently killing the batcher
      logger.error('Batch tick failed unexpectedly', { error: err })
    }
    scheduleNextTick()
  }, flushIntervalMs)

  // Don't hold the process open just for batch ticks
  timer.unref()
}

async function tick(): Promise<void> {
  // Guard: skip if nothing to send
  if (eventQueue.size() === 0) return

  // Guard: SDK must be initialized before sending
  if (!client.initialized) {
    logger.debug('Batch tick skipped — SDK not yet initialized', {
      queueSize: eventQueue.size(),
    })
    return
  }

  // Guard: memory pressure — degrade gracefully under heap pressure
  const pressure = memoryMonitor.getState()
  if (pressure.level === 'critical') {
    logger.warn('Batch tick skipped — critical memory pressure', {
      heapUsedMb: pressure.heapUsedMb,
      heapTotalMb: pressure.heapTotalMb,
      heapUtilization: pressure.heapUtilization.toFixed(2),
      queueSize: eventQueue.size(),
    })
    return
  }

  // Guard: circuit breaker is open — buffer, don't send
  if (!circuitBreaker.canExecute()) {
    logger.warn('Batch tick skipped — circuit breaker OPEN (will auto-reset after timeout)', {
      circuitState: circuitBreaker.getState(),
      queueSize: eventQueue.size(),
    })
    return
  }

  // Guard: rate limiter throttle
  if (!rateLimiter.tryAcquire()) {
    logger.warn('Batch tick skipped — rate limited', {
      queueSize: eventQueue.size(),
    })
    return
  }

  // Guard: concurrent flight limit
  if (inFlightCount >= maxConcurrentSends) {
    logger.warn('Batch tick skipped — max concurrent sends reached', {
      inFlightCount,
      maxConcurrentSends,
    })
    return
  }

  const events = eventQueue.drain(batchSize)
  if (events.length === 0) return

  inFlightCount += 1

  try {
    await sendEvents(events)
    circuitBreaker.recordSuccess()

    logger.info('Batch sent successfully', {
      eventCount: events.length,
      queueRemaining: eventQueue.size(),
      circuitState: circuitBreaker.getState(),
    })
  } catch (err) {
    circuitBreaker.recordFailure()
    // Re-queue events instead of permanently dropping them
    eventQueue.requeueFront(events)

    const cbState = circuitBreaker.getState()
    logger.error('Batch send failed; events re-queued', {
      error: err instanceof Error ? err.message : String(err),
      eventCount: events.length,
      queueSize: eventQueue.size(),
      circuitState: cbState,
      willSkipFutureBatches: cbState === 'OPEN',
    })
  } finally {
    inFlightCount -= 1
  }
}
