/**
 * SDK Initialization — refactored for remote-config-driven architecture.
 *
 * Flow:
 * 1. Validate user options via Zod schema
 * 2. Initialize ConfigManager (fetches POST /v1/sdk-config with 3s timeout)
 * 3. Enforce VersionPolicy (blocked/force_upgrade/degraded/ok)
 * 4. Initialize KillswitchEngine (reactive per-subsystem control)
 * 5. Initialize SamplingEngine (FNV-1a deterministic)
 * 6. Initialize FeatureController (skip class instantiation for disabled features)
 * 7. Initialize SecurityScrubber (pre-transport PII/header scrubbing)
 * 8. Initialize LimitsEngine (rate limiting, attribute trimming)
 * 9. Initialize TransportRouter (8 independent route managers)
 * 10. Register subsystems with FeatureController (tracing, metrics, errors, logging, profiling, crons)
 * 11. Wire config change listeners for hot-swap
 * 12. Start ConfigManager refresh loop
 * 13. Backward-compatible legacy init flow preserved
 *
 * Config merge priority: Baked-in SDK defaults → Remote Config → User init() options.
 */
import type { SDKInitOptions, RemoteConfig } from '../types/config.js';
/**
 * Initialize the SDK.
 *
 * @param options - SDK configuration options
 * @returns The resolved remote config, or undefined if init failed gracefully
 */
export declare function init(options: SDKInitOptions): Promise<Readonly<RemoteConfig> | undefined>;
//# sourceMappingURL=init.d.ts.map