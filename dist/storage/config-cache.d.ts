import type { RemoteConfigResponse } from '../types/config.js';
import type { InitResponse } from '../core/remote-config-client.js';
export interface CachedConfigPayload {
    readonly version: 1;
    readonly cachedAt: string;
    readonly projectId: string;
    readonly environment: string;
    readonly release: string;
    readonly configRevision?: number | null | undefined;
    readonly config: RemoteConfigResponse;
}
/**
 * Save a validated RemoteConfigResponse to disk for cold-start LKG recovery.
 * Never writes raw API keys, Authorization headers, tokens, or credentials.
 * Asynchronous and fire-and-forget: errors are logged at debug level and swallowed.
 */
export declare function saveConfigCache(apiKey: string, response: InitResponse): Promise<void>;
/**
 * Load and validate a cached Last-Known-Good configuration from disk.
 * Returns null if the cache does not exist, cannot be read, or fails schema validation.
 */
export declare function loadConfigCache(apiKey: string): Promise<InitResponse | null>;
/**
 * Remove cached configuration from disk (used during tests or key revocation).
 */
export declare function clearConfigCache(apiKey: string): Promise<void>;
