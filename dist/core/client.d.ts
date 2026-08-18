import type { RemoteConfigResponse, SDKInitOptions } from '../types/config.js';
import type { SDKPlugin, EventProcessor } from '../types/plugin.js';
import type { EventMetadata } from '../types/event.js';
import type { Breadcrumb } from '../types/breadcrumb.js';
import type { InitResponse } from './remote-config-client.js';
import { RingBuffer } from './ring-buffer.js';
declare class SDKClient {
    private static instance;
    private initializedValue;
    private initMetadataValue;
    private initPromise;
    private apiKeyValue;
    private initIdentityValue;
    private pendingInitIdentityValue;
    private optionsValue;
    private readonly pluginRegistry;
    private readonly eventProcessorRegistry;
    private metadataValue;
    private breadcrumbBuffer;
    private constructor();
    static getInstance(): SDKClient;
    get initialized(): boolean;
    get remoteConfig(): Readonly<RemoteConfigResponse> | null;
    get initResponse(): Readonly<InitResponse> | null;
    get projectId(): string | null;
    get options(): Readonly<SDKInitOptions> | null;
    get metadata(): Readonly<EventMetadata>;
    get plugins(): readonly SDKPlugin[];
    get eventProcessors(): readonly EventProcessor[];
    get breadcrumbs(): RingBuffer<Breadcrumb>;
    setOptions(options: SDKInitOptions): void;
    /**
     * Apply the authoritative identity fields from the active remote
     * configuration snapshot. `projectId` always comes exclusively from
     * `config.sdk.projectId` — never from init options, local config,
     * package.json, environment variables, or any other fallback.
     */
    applyRemoteIdentity(config: Readonly<RemoteConfigResponse>): void;
    markInitialized(): void;
    setInitResponse(response: InitResponse): void;
    clearConfig(): void;
    clear(): void;
    getApiKey(): string;
    hasSameIdentity(options: SDKInitOptions): boolean;
    setPendingIdentity(options: SDKInitOptions): void;
    clearPendingIdentity(): void;
    hasSamePendingIdentity(options: SDKInitOptions): boolean;
    setInitPromise(promise: Promise<Readonly<RemoteConfigResponse> | undefined> | null): void;
    getInitPromise(): Promise<Readonly<RemoteConfigResponse> | undefined> | null;
    registerPlugin(plugin: SDKPlugin): void;
    registerEventProcessor(processor: EventProcessor): void;
    initBreadcrumbs(capacity: number): void;
}
export declare const client: SDKClient;
export {};
//# sourceMappingURL=client.d.ts.map