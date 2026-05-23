/**
 * ConfigDiffer — deep-diff utility for RemoteConfigResponse objects.
 *
 * Used by the config refresh loop to determine which sections changed
 * and what subsystems need dynamic reconfiguration.
 */
import type { RemoteConfigResponse, ConfigDiff } from '../types/config.js';
/**
 * Deep-diff two remote config objects.
 * Returns a ConfigDiff describing which top-level sections changed.
 */
export declare function diffConfigs(oldConfig: Readonly<RemoteConfigResponse>, newConfig: Readonly<RemoteConfigResponse>): ConfigDiff;
//# sourceMappingURL=config-differ.d.ts.map