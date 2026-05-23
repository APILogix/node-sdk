/**
 * Plugin Manager — orchestrates plugin lifecycle.
 *
 * Responsibilities:
 * - Plugin registration with uniqueness validation
 * - Ordered plugin initialization via setup() hooks
 * - Ordered plugin teardown during shutdown
 * - Error isolation — one plugin failure never blocks others
 */
import { client } from '../core/client.js';
import { getLogger } from '../utils/logger.js';
/**
 * Register and initialize all plugins from SDK options.
 * Called once during SDK initialization after config is resolved.
 */
export async function initializePlugins(plugins, config, metadata) {
    const logger = getLogger();
    for (const plugin of plugins) {
        try {
            // Validate plugin interface
            if (!plugin.meta?.name) {
                logger.warn('Skipping plugin without meta.name');
                continue;
            }
            // Register (checks for duplicates)
            client.registerPlugin(plugin);
            logger.debug('Plugin registered', {
                pluginName: plugin.meta.name,
                pluginVersion: plugin.meta.version,
            });
        }
        catch (error) {
            logger.warn('Plugin registration failed', {
                pluginName: plugin.meta?.name ?? '<unknown>',
                error,
            });
        }
    }
    // Initialize all registered plugins
    const context = {
        config,
        metadata: {
            service: metadata.service,
            environment: metadata.environment,
            release: metadata.release,
            sdkVersion: metadata.sdkVersion,
        },
    };
    for (const plugin of client.plugins) {
        if (plugin.setup) {
            try {
                await plugin.setup(context);
                logger.debug('Plugin initialized', {
                    pluginName: plugin.meta.name,
                });
            }
            catch (error) {
                // Plugin setup failures are isolated — log and continue
                logger.warn('Plugin setup failed', {
                    pluginName: plugin.meta.name,
                    error,
                });
            }
        }
    }
    logger.debug('All plugins initialized', {
        pluginCount: client.plugins.length,
        pluginNames: client.plugins.map(p => p.meta.name),
    });
}
/**
 * Tear down all registered plugins in reverse order.
 * Called during SDK shutdown.
 */
export async function teardownPlugins() {
    const logger = getLogger();
    const plugins = [...client.plugins].reverse();
    for (const plugin of plugins) {
        if (plugin.teardown) {
            try {
                await plugin.teardown();
                logger.debug('Plugin torn down', {
                    pluginName: plugin.meta.name,
                });
            }
            catch (error) {
                logger.warn('Plugin teardown failed', {
                    pluginName: plugin.meta.name,
                    error,
                });
            }
        }
    }
}
