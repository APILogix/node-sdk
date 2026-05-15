/**
 * SDK Initialization — the entry point for configuring and starting the SDK.
 *
 * Flow:
 * 1. Validate user options via zod schema
 * 2. Handshake with server (/v1/init) to get remote config
 * 3. Merge user options + remote config into ResolvedSDKConfig
 * 4. Initialize breadcrumb buffer, plugins, event processors
 * 5. Start batcher, register global error handlers, signal handlers
 * 6. SDK is ready — events flow through the pipeline
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