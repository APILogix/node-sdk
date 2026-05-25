/**
 * ConfigDiffer — deep-diff utility for RemoteConfigResponse objects.
 *
 * The refresh loop calls this on every successful fetch so subsystems can
 * decide whether to react. Cheap by design: a structural equality check
 * per top-level section, not a per-field traversal of the full tree.
 */
import type { RemoteConfigResponse, ConfigDiff } from '../types/config.js';
/**
 * Diff two remote config snapshots. Returns which top-level sections
 * changed and a flat map of field-level changes for diagnostic logging.
 */
export declare function diffConfigs(oldConfig: Readonly<RemoteConfigResponse>, newConfig: Readonly<RemoteConfigResponse>): ConfigDiff;
//# sourceMappingURL=config-differ.d.ts.map