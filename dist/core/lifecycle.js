/**
 * SDK Lifecycle — enterprise-grade graceful shutdown with:
 * - Bounded timeout with Promise.race
 * - Shutdown rejection (no new events after shutdown starts)
 * - beforeShutdown hooks
 * - OTel tracer + metrics force-flush
 * - Async event pipeline drain
 * - Persistent storage drain-to-disk
 * - Signal handler management (SIGTERM, SIGINT)
 */
import { flush, stopBatcher } from '../transport/batcher.js';
import { eventQueue } from '../transport/queue.js';
import { client } from './client.js';
import { getLogger } from '../utils/logger.js';
import { teardownPlugins } from '../plugins/index.js';
import { shutdownTracer, flushTracer } from '../tracing/tracer.js';
import { resetSessionManager } from '../session/session-manager.js';
import { resetGlobalErrorHandlers } from '../instrumentation/global-errors.js';
import { errorDeduplicator } from '../processors/deduplicator.js';
import { persistentStorage } from '../storage/persistent-storage.js';
import { metricsRegistry } from '../metrics/registry.js';
import { otelMetrics } from '../metrics/otel-adapter.js';
import { drainPendingEventProcessing } from './event-pipeline.js';
let signalHandlersRegistered = false;
let shuttingDown = false;
// Store signal handler references for proper cleanup on reinit
let sigTermHandler = null;
let sigIntHandler = null;
// beforeShutdown hooks — registered by subsystems or users
const beforeShutdownHooks = [];
const HOOK_TIMEOUT_MS = 5_000;
/**
 * Check if the SDK is currently shutting down.
 * Used by capture paths and queue to reject new events.
 */
export function isSDKShuttingDown() {
    return shuttingDown;
}
/**
 * Register a hook to be called before shutdown begins.
 * Hooks are called in registration order with a timeout.
 */
export function onBeforeShutdown(hook) {
    beforeShutdownHooks.push(hook);
}
/**
 * Graceful shutdown — flushes remaining events and tears down plugins.
 *
 * Shutdown sequence:
 * 1. Set shuttingDown flag (reject new events)
 * 2. Call beforeShutdown hooks
 * 3. Stop batcher timer
 * 4. Force-flush OTel tracer (pending spans)
 * 5. Shutdown tracer provider
 * 6. Flush OTel metrics
 * 7. Drain async event pipeline processing
 * 8. Flush transport queue
 * 9. Teardown plugins
 * 10. Reset session manager
 * 11. Reset global error handlers
 * 12. Stop deduplicator
 * 13. Drain remaining events to disk
 * 14. Shutdown persistent storage
 *
 * @param timeoutMs - Maximum time to wait for flush/teardown. Default: 10000.
 */
export async function shutdown(timeoutMs) {
    if (shuttingDown) {
        getLogger().debug('Shutdown already in progress, skipping duplicate call');
        return;
    }
    shuttingDown = true;
    eventQueue.setShuttingDown(true);
    const logger = getLogger();
    const timeout = timeoutMs ?? client.options?.shutdownTimeoutMs ?? 10_000;
    logger.info('SDK shutdown started', {
        queuedEventCount: eventQueue.size(),
        timeoutMs: timeout,
    });
    // Race: flush + teardown vs timeout
    const shutdownWork = async () => {
        // Step 1: beforeShutdown hooks
        for (const hook of beforeShutdownHooks) {
            try {
                await Promise.race([
                    hook(),
                    new Promise((_, reject) => {
                        const t = setTimeout(() => reject(new Error('beforeShutdown hook timed out')), HOOK_TIMEOUT_MS);
                        t.unref();
                    }),
                ]);
            }
            catch (hookError) {
                logger.warn('beforeShutdown hook failed', { error: hookError });
            }
        }
        // Step 2: Stop batcher (no more batch ticks)
        stopBatcher();
        // Step 3: Force-flush OTel tracer (pending spans)
        try {
            await flushTracer();
        }
        catch (tracerFlushError) {
            logger.warn('Tracer flush failed during shutdown', { error: tracerFlushError });
        }
        // Step 4: Shutdown tracer provider
        try {
            await shutdownTracer();
        }
        catch (tracerError) {
            logger.warn('Tracer shutdown failed during shutdown', { error: tracerError });
        }
        // Step 5: Flush OTel metrics
        try {
            metricsRegistry.flush();
            await otelMetrics.shutdown();
            metricsRegistry.stop();
        }
        catch (metricsError) {
            logger.warn('Metrics shutdown failed during shutdown', { error: metricsError });
        }
        // Step 6: Drain async event pipeline processing
        try {
            await drainPendingEventProcessing();
        }
        catch (drainError) {
            logger.warn('Event pipeline drain failed during shutdown', { error: drainError });
        }
        // Step 7: Flush transport queue
        try {
            await flush();
        }
        catch (flushError) {
            logger.warn('Flush failed during shutdown', { error: flushError });
        }
        // Step 8: Teardown plugins
        try {
            await teardownPlugins();
        }
        catch (teardownError) {
            logger.warn('Plugin teardown failed during shutdown', { error: teardownError });
        }
        // Step 9: Reset session manager
        try {
            resetSessionManager();
        }
        catch (sessionError) {
            logger.warn('Session manager reset failed during shutdown', { error: sessionError });
        }
        // Step 10: Clean up global error handlers
        try {
            resetGlobalErrorHandlers();
        }
        catch (handlerError) {
            logger.warn('Global error handler reset failed during shutdown', { error: handlerError });
        }
        // Step 11: Stop deduplicator
        try {
            errorDeduplicator.stop();
        }
        catch (dedupError) {
            logger.warn('Error deduplicator stop failed during shutdown', { error: dedupError });
        }
        // Step 12: Persistent storage shutdown
        try {
            await persistentStorage.shutdown();
        }
        catch (storageError) {
            logger.warn('Persistent storage shutdown failed', { error: storageError });
        }
    };
    try {
        await Promise.race([
            shutdownWork(),
            new Promise((_, reject) => {
                const t = setTimeout(() => reject(new Error('Shutdown timeout exceeded')), timeout);
                t.unref();
            }),
        ]);
    }
    catch (error) {
        logger.warn('Shutdown timed out — some events may be lost', {
            error,
            remainingEvents: eventQueue.size(),
        });
    }
    finally {
        // Drain any remaining events to disk as last resort
        const remaining = eventQueue.drainAll();
        for (const event of remaining) {
            persistentStorage.persist(event);
        }
        await persistentStorage.flush().catch(error => {
            logger.warn('Failed to persist remaining events during shutdown cleanup', { error });
        });
        eventQueue.clear();
        client.clear();
        shuttingDown = false;
        eventQueue.setShuttingDown(false);
        // Clear hooks for clean reinit
        beforeShutdownHooks.length = 0;
        logger.info('SDK shutdown completed', {
            deadLetterCount: eventQueue.getDeadLetterCount(),
        });
    }
}
/**
 * Register SIGTERM/SIGINT handlers for automatic graceful shutdown.
 * Called once during SDK initialization.
 */
export function registerSignalHandlers() {
    if (signalHandlersRegistered)
        return;
    signalHandlersRegistered = true;
    const logger = getLogger();
    const handleSignal = (signal) => {
        logger.info(`Received ${signal} — initiating graceful shutdown`);
        shutdown().catch(err => {
            logger.error('Shutdown failed after signal', { signal, error: err });
        });
    };
    sigTermHandler = () => handleSignal('SIGTERM');
    sigIntHandler = () => handleSignal('SIGINT');
    process.once('SIGTERM', sigTermHandler);
    process.once('SIGINT', sigIntHandler);
}
/**
 * Remove signal handlers and reset state — enables clean reinit.
 * @internal
 */
export function resetSignalHandlers() {
    if (sigTermHandler) {
        process.removeListener('SIGTERM', sigTermHandler);
        sigTermHandler = null;
    }
    if (sigIntHandler) {
        process.removeListener('SIGINT', sigIntHandler);
        sigIntHandler = null;
    }
    signalHandlersRegistered = false;
}
/** Re-export flush for public API. */
export { flush };
//# sourceMappingURL=lifecycle.js.map