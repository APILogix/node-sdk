import type { RemoteConfigResponse } from '../types/config.js'
import { ConfigManager } from './config-manager.js'

/** Return the active immutable runtime configuration. */
export function getConfig(): Readonly<RemoteConfigResponse> {
  return ConfigManager.getInstance().getConfig()
}
