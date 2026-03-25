import type { RemoteConfig, SDKInitOptions } from "../types/config.js";
declare class SDKClient {
    private static instance;
    config: RemoteConfig | null;
    options: SDKInitOptions;
    initialized: boolean;
    private constructor();
    static getInstance(): SDKClient;
    setOptions(options: SDKInitOptions): void;
    setConfig(config: RemoteConfig): void;
    markInitialized(): void;
}
export declare const client: SDKClient;
export {};
//# sourceMappingURL=client.d.ts.map