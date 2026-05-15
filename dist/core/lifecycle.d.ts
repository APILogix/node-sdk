/**
 * SDK Lifecycle — graceful shutdown with timeout, signal handling, plugin teardown.
 */
import { flush } from '../transport/batcher.js';
/**
 * Graceful shutdown — flushes remaining events and tears down plugins.
 *
 * @param timeoutMs - Maximum time to wait for flush/teardown. Default: 10000.
 */
export declare function shutdown(timeoutMs?: number): Promise<void>;
/**
 * Register SIGTERM/SIGINT handlers for automatic graceful shutdown.
 * Called once during SDK initialization.
 */
export declare function registerSignalHandlers(): void;
/** Re-export flush for public API. */
export { flush };
//# sourceMappingURL=lifecycle.d.ts.map