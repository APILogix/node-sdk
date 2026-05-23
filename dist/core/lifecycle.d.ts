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
import { flush } from '../transport/batcher.js';
/**
 * Check if the SDK is currently shutting down.
 * Used by capture paths and queue to reject new events.
 */
export declare function isSDKShuttingDown(): boolean;
/**
 * Register a hook to be called before shutdown begins.
 * Hooks are called in registration order with a timeout.
 */
export declare function onBeforeShutdown(hook: () => Promise<void>): void;
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
export declare function shutdown(timeoutMs?: number): Promise<void>;
/**
 * Register SIGTERM/SIGINT handlers for automatic graceful shutdown.
 * Called once during SDK initialization.
 */
export declare function registerSignalHandlers(): void;
/**
 * Remove signal handlers and reset state — enables clean reinit.
 * @internal
 */
export declare function resetSignalHandlers(): void;
/** Re-export flush for public API. */
export { flush };
//# sourceMappingURL=lifecycle.d.ts.map