/**
 * SDK Lifecycle — graceful shutdown with timeout, signal handling, plugin teardown.
 */

import { flush, stopBatcher } from '../transport/batcher.js'
import { eventQueue } from '../transport/queue.js'
import { client } from './client.js'
import { getLogger } from '../utils/logger.js'
import { teardownPlugins } from '../plugins/index.js'
import { shutdownTracer } from '../tracing/tracer.js'
import { resetSessionManager } from '../session/session-manager.js'
import { resetGlobalErrorHandlers } from '../instrumentation/global-errors.js'
import { errorDeduplicator } from '../processors/deduplicator.js'
import { persistentStorage } from '../storage/persistent-storage.js'
import { metricsRegistry } from '../metrics/registry.js'
import { otelMetrics } from '../metrics/otel-adapter.js'

let signalHandlersRegistered = false
let isShuttingDown = false

// Store signal handler references for proper cleanup on reinit
let sigTermHandler: (() => void) | null = null
let sigIntHandler: (() => void) | null = null

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

    try {
      await shutdownTracer()
    } catch (tracerError) {
      logger.warn('Tracer shutdown failed during shutdown', { error: tracerError })
    }

    try {
      resetSessionManager()
    } catch (sessionError) {
      logger.warn('Session manager reset failed during shutdown', { error: sessionError })
    }

    // Clean up global error handlers to prevent listener leaks
    try {
      resetGlobalErrorHandlers()
    } catch (handlerError) {
      logger.warn('Global error handler reset failed during shutdown', { error: handlerError })
    }

    try {
      errorDeduplicator.stop()
    } catch (dedupError) {
      logger.warn('Error deduplicator stop failed during shutdown', { error: dedupError })
    }

    try {
      persistentStorage.shutdown()
    } catch (storageError) {
      logger.warn('Persistent storage shutdown failed', { error: storageError })
    }

    try {
      metricsRegistry.flush()
      metricsRegistry.stop()
    } catch (metricsError) {
      logger.warn('Metrics registry shutdown failed during shutdown', { error: metricsError })
    }

    try {
      await otelMetrics.shutdown()
    } catch (otelMetricsError) {
      logger.warn('OTel metrics shutdown failed during shutdown', { error: otelMetricsError })
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

  sigTermHandler = () => handleSignal('SIGTERM')
  sigIntHandler = () => handleSignal('SIGINT')

  process.once('SIGTERM', sigTermHandler)
  process.once('SIGINT', sigIntHandler)
}

/**
 * Remove signal handlers and reset state — enables clean reinit.
 * @internal
 */
export function resetSignalHandlers(): void {
  if (sigTermHandler) {
    process.removeListener('SIGTERM', sigTermHandler)
    sigTermHandler = null
  }
  if (sigIntHandler) {
    process.removeListener('SIGINT', sigIntHandler)
    sigIntHandler = null
  }
  signalHandlersRegistered = false
}

/** Re-export flush for public API. */
export { flush }
