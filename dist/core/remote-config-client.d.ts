import { BACKEND_BASE_URL } from '../constants/defaults.js';
export { BACKEND_BASE_URL };
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
interface RemoteConfigClientOptions {
    readonly apiKey: string;
    readonly initTimeoutMs?: number | undefined;
    readonly initRetries?: number | undefined;
    readonly baseUrl?: string | undefined;
    readonly timeoutMs?: number | undefined;
    readonly fetchImpl?: typeof fetch | undefined;
}
/**
 * The SDK's sole control-plane network client.
 *
 * It intentionally knows only two operations. Startup has a bounded retry for
 * transient failures; refreshes neither retry nor poll.
 */
export declare class RemoteConfigClient {
    private readonly apiKey;
    private readonly baseUrl;
    private readonly timeoutMs;
    private readonly initTimeoutMs;
    private readonly initRetries;
    private readonly fetchImpl;
    constructor(options: RemoteConfigClientOptions);
    /** Perform the one and only startup request. */
    initialize(): Promise<InitResponse>;
    /** Download a complete replacement snapshot after a telemetry change signal or TTL expiry. */
    fetchLatest(currentRevision?: number | null, currentHash?: string | null): Promise<unknown>;
    /**
     * Retries only transient startup failures. The configured init timeout is a
     * deadline for the entire sequence, not a timeout per attempt, so enabling
     * reliability never turns a 1.5s startup budget into a multi-second stall.
     */
    private postInitWithRetry;
    private post;
}
