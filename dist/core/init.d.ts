/**
 * SDK Initialization — the entry point for configuring and starting the SDK.
 *
 * Flow:
 * 1. Validate user options via zod schema
 * 2. Handshake with server (/v1/init) to get remote config + plan tier
 * 3. Resolve plan features (free / pro / enterprise)
 * 4. Merge user options + remote config into ResolvedSDKConfig
 * 5. Clamp resolved config to plan limits (features OFF if plan doesn't allow)
 * 6. Initialize breadcrumb buffer, plugins, event processors
 * 7. Start batcher, register global error handlers, signal handlers
 * 8. SDK is ready — events flow through the pipeline
 *
 * All features are ON by default — the plan tier caps what's allowed.
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