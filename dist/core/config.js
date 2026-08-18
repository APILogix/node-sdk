import { ConfigManager } from './config-manager.js';
/** Return the active immutable runtime configuration. */
export function getConfig() {
    return ConfigManager.getInstance().getConfig();
}
//# sourceMappingURL=config.js.map