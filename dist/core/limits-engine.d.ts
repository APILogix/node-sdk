/**
 * LimitsEngine — enforces payload and resource limits from remote config.
 *
 * Backed by a complete validated `LimitsConfig`. Out-of-range snapshots are
 * rejected before this engine sees them; values are not merged or clamped.
 *
 * Responsibilities:
 *   - maxPayloadSize: reject oversized serialized payloads pre-transport.
 *   - maxSpanAttributes: bound attribute count on spans/events.
 *   - maxAttributeLength: truncate long attribute string values.
 *
 * The previous schema's `maxEventsPerSecond` rate limiter has been removed —
 * load shedding is now done by `loadShedder` and `tenantGovernor`, which
 * make smarter, pressure-aware decisions. `maxBreadcrumbs` is now an init
 * option, not part of remote config (a per-process concern, not a tenant
 * one).
 */
import type { LimitsConfig, ConfigDiff, RemoteConfigResponse } from '../types/config.js';
import type { SDKEvent } from '../types/event.js';
export declare class LimitsEngine {
    private static instance;
    private config;
    private destroyed;
    private constructor();
    static initialize(config: LimitsConfig): LimitsEngine;
    static getInstance(): LimitsEngine | null;
    /**
     * Enforce attribute limits on an event. Returns a new event (never mutates).
     */
    enforceAttributeLimits<T extends SDKEvent>(event: T): T;
    /** Returns true if the payload is within the configured size limit. */
    checkPayloadSize(serializedBytes: number): boolean;
    /** Maximum spans allowed in a single trace. */
    getMaxSpansPerTrace(): number;
    handleConfigChange(_diff: ConfigDiff, newConfig: Readonly<RemoteConfigResponse>): void;
    getConfig(): Readonly<LimitsConfig>;
    private trimAttributes;
    private needsTruncation;
    private truncateValue;
    destroy(): void;
    static reset(): void;
}
//# sourceMappingURL=limits-engine.d.ts.map