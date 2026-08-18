/**
 * Plugin Manager — orchestrates plugin lifecycle.
 *
 * Responsibilities:
 * - Plugin registration with uniqueness validation
 * - Ordered plugin initialization via setup() hooks
 * - Ordered plugin teardown during shutdown
 * - Error isolation — one plugin failure never blocks others
 */
import type { SDKPlugin } from '../types/plugin.js';
import type { RemoteConfigResponse } from '../types/config.js';
import type { EventMetadata } from '../types/event.js';
/**
 * Register and initialize all plugins from SDK options.
 * Called once during SDK initialization after config is resolved.
 */
export declare function initializePlugins(plugins: readonly SDKPlugin[], config: Readonly<RemoteConfigResponse>, metadata: EventMetadata): Promise<void>;
/**
 * Tear down all registered plugins in reverse order.
 * Called during SDK shutdown.
 */
export declare function teardownPlugins(): Promise<void>;
//# sourceMappingURL=index.d.ts.map