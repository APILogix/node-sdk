/** Production control-plane origin and hard validation safety bounds. */
/** Production SaaS API origin used when neither baseUrl nor SDK_BASE_URL is provided. */
export declare const DEFAULT_API_BASE_URL = "https://api.veyontix.com";
/** Resolve the control-plane origin; this selects an endpoint, not runtime policy. */
export declare function resolveApiBaseUrl(baseUrl?: string): string;
/**
 * Absolute bounds for complete backend snapshots. Values outside these bounds
 * make the entire snapshot invalid; they are never clamped or merged.
 */
export declare const SAFETY_CEILINGS: Readonly<{
    readonly maxSpansPerTrace: 5000;
    readonly maxSpanAttributes: 500;
    readonly maxAttributeLength: number;
    readonly maxPayloadSize: number;
    readonly maxQueueSize: 100000;
    readonly maxMemoryMb: 1024;
    readonly batchSize: 5000;
    readonly flushIntervalMs: number;
    readonly timeoutMs: 60000;
    readonly retryMaxRetries: 10;
    readonly retryBaseDelayMs: 30000;
}>;
//# sourceMappingURL=defaults.d.ts.map