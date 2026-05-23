/**
 * LimitsEngine — enforces payload and resource limits from remote config.
 *
 * Responsibilities:
 * - maxPayloadSize: Reject payloads exceeding limit before serialization.
 * - maxAttributesPerEvent: Trim excess attributes.
 * - maxAttributeLength: Truncate long attribute values.
 * - maxBreadcrumbs: Cap breadcrumb ring buffer.
 * - maxEventsPerSecond: Token-bucket rate limiter.
 * - maxMemoryUsageMb / maxCpuOverheadPercent: Resource monitors (advisory, log warnings).
 *
 * All enforcement is pre-transport — events are shaped before entering the queue.
 */
import type { LimitsConfig, ConfigDiff, RemoteConfigResponse } from '../types/config.js';
import type { SDKEvent } from '../types/event.js';
export declare class LimitsEngine {
    private static instance;
    private config;
    private destroyed;
    private tokenBucket;
    private lastRefillTime;
    private eventsDropped;
    private constructor();
    static initialize(config: LimitsConfig): LimitsEngine;
    static getInstance(): LimitsEngine | null;
    /**
     * Check if an event can be admitted (token bucket).
     * Returns true if admitted, false if rate-limited.
     */
    admitEvent(): boolean;
    /**
     * Enforce attribute limits on an event.
     * Trims excess attributes and truncates long values.
     * Returns a new event (does not mutate the input).
     */
    enforceAttributeLimits<T extends SDKEvent>(event: T): T;
    /**
     * Check if a serialized payload exceeds the max payload size.
     * Returns true if the payload is within limits.
     */
    checkPayloadSize(serializedBytes: number): boolean;
    /** Get the maximum breadcrumbs allowed. */
    getMaxBreadcrumbs(): number;
    /** Handle config change — hot-swap limits. */
    handleConfigChange(_diff: ConfigDiff, newConfig: Readonly<RemoteConfigResponse>): void;
    /** Get current config. */
    getConfig(): Readonly<LimitsConfig>;
    /** Get drop stats. */
    getDroppedCount(): number;
    private refillTokens;
    private trimAttributes;
    private needsTruncation;
    private truncateValue;
    destroy(): void;
    static reset(): void;
}
//# sourceMappingURL=limits-engine.d.ts.map