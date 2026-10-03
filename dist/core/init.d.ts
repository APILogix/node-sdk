import type { RemoteConfigResponse, SDKInitOptions } from '../types/config.js';
import { RemoteConfigClient, type InitResponse } from './remote-config-client.js';
/**
 * Initialize from exactly one complete remote snapshot returned by POST
 * /v1/init. Failure is fail-open to the host application but does not invent
 * a runtime configuration or start telemetry with defaults.
 */
export declare function init(options: string | SDKInitOptions): Promise<Readonly<RemoteConfigResponse> | undefined>;
export declare function activateSDK(remoteClient: RemoteConfigClient, response: InitResponse, options: SDKInitOptions, mode?: 'cold_start' | 'recovery' | 'manual'): Promise<Readonly<RemoteConfigResponse> | undefined>;
declare function enterDormantState(_error?: unknown, options?: SDKInitOptions): Promise<void>;
export declare const cleanupFailedInitialization: typeof enterDormantState;
export {};
