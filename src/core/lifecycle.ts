/**
 * SDK Lifecycle — graceful shutdown with timeout, signal handling, plugin teardown.
 */

import { flush, stopBatcher } from '../transport/batcher.js'
import { eventQueue } from '../transport/queue.js'
import { client } from './client.js'
import { getLogger } from '../utils/logger.js'
import { teardownPlugins } from '../plugins/index.js'

let signalHandlersRegistered = false
let isShuttingDown = false

/**
 * Graceful shutdown — flushes remaining events and tears down plugins.
 *
 * @param timeoutMs - Maximum time to wait for flush/teardown. Default: 10000.
 */
export async function shutdown(timeoutMs?: number): Promise<void> {
  if (isShuttingDown) {
    getLogger().debug('Shutdown already in progress, skipping duplicate call')
    return
  }

  isShuttingDown = true
  const logger = getLogger()
  const timeout = timeoutMs ?? client.options?.shutdownTimeoutMs ?? 10_000

  logger.info('SDK shutdown started', {
    queuedEventCount: eventQueue.size(),
    timeoutMs: timeout,
  })

  // Stop accepting new batch ticks
  stopBatcher()

  // Race: flush + teardown vs timeout
  const shutdownWork = async () => {
    try {
      await flush()
    } catch (flushError) {
      logger.warn('Flush failed during shutdown', { error: flushError })
    }

    try {
      await teardownPlugins()
    } catch (teardownError) {
      logger.warn('Plugin teardown failed during shutdown', { error: teardownError })
    }
  }

  try {
    await Promise.race([
      shutdownWork(),
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error('Shutdown timeout exceeded')), timeout)
      ),
    ])
  } catch (error) {
    logger.warn('Shutdown timed out — some events may be lost', {
      error,
      remainingEvents: eventQueue.size(),
    })
  } finally {
    eventQueue.clear()
    client.clear()
    isShuttingDown = false

    logger.info('SDK shutdown completed', {
      deadLetterCount: eventQueue.getDeadLetterCount(),
    })
  }
}

/**
 * Register SIGTERM/SIGINT handlers for automatic graceful shutdown.
 * Called once during SDK initialization.
 */
export function registerSignalHandlers(): void {
  if (signalHandlersRegistered) return
  signalHandlersRegistered = true

  const logger = getLogger()

  const handleSignal = (signal: string) => {
    logger.info(`Received ${signal} — initiating graceful shutdown`)
    shutdown().catch(err => {
      logger.error('Shutdown failed after signal', { signal, error: err })
    })
  }

  process.once('SIGTERM', () => handleSignal('SIGTERM'))
  process.once('SIGINT', () => handleSignal('SIGINT'))
}

/** Re-export flush for public API. */
export { flush }
