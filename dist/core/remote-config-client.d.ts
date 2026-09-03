import type { RemoteConfigResponse } from '../types/config.js';
export interface InitResponse {
    readonly success: boolean;
    readonly projectId: string;
    readonly organizationId?: string | undefined;
    readonly environmentId?: string | undefined;
    readonly environment: string;
    readonly release: string;
    readonly project?: Readonly<Record<string, unknown>> | undefined;
    readonly configRevision?: number | null | undefined;
    readonly configHash?: string | null | undefined;
    readonly config: RemoteConfigResponse;
}
export interface RemoteConfigClientOptions {
    readonly apiKey: string;
    readonly baseUrl?: string | undefined;
    readonly timeoutMs?: number | undefined;
    readonly fetchImpl?: typeof fetch | undefined;
}
/**
 * The SDK's sole control-plane network client.
 *
 * It intentionally knows only two operations. Neither operation retries or
 * polls; callers decide when a request is allowed.
 */
export declare class RemoteConfigClient {
    private readonly apiKey;
    private readonly baseUrl;
    private readonly timeoutMs;
    private readonly fetchImpl;
    constructor(options: RemoteConfigClientOptions);
    /** Perform the one and only startup request. */
    initialize(): Promise<InitResponse>;
    /** Download a complete replacement snapshot after a telemetry change signal. */
    fetchLatest(): Promise<unknown>;
    private post;
}
