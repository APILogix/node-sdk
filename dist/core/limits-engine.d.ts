/**
 * LimitsEngine — enforces payload and resource limits from remote config.
 *
 * Backed by `LimitsConfig`, which is itself clamped to `SAFETY_CEILINGS`
 * before reaching this engine. The wire schema (post v3 migration) only
 * carries the bounds the backend cares about; per-attribute counts and
 * lengths are reused for both span attributes and event-level fields like
 * `context`, `attributes`, and `tags`.
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
     * Backwards-compatible no-op admission gate.
     *
     * Rate limiting moved to `loadShedder` + `tenantGovernor`. We keep this
     * method so the event pipeline doesn't have to fork by SDK version, but
     * it always returns `true`. Removed entirely once the pipeline stops
     * calling it.
     */
    admitEvent(): boolean;
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