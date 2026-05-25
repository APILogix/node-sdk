/**
 * SecurityScrubber — enforces privacy.scrubbing and privacy.piiDetection config.
 *
 * Pre-transport processor that:
 * 1. Scrubs sensitive headers (authorization, cookie, etc.)
 * 2. Scrubs sensitive body fields (password, token, secret, etc.)
 * 3. Scrubs sensitive query parameters (uses the same `fields` list as bodies)
 * 4. Detects and masks PII (emails, phones, IPs)
 *
 * All scrubbing is done on the event BEFORE it enters the transport queue.
 * The scrubber returns a new event — it never mutates the original.
 */
import type { PrivacyConfig, ConfigDiff, RemoteConfigResponse } from '../types/config.js';
import type { SDKEvent } from '../types/event.js';
export declare class SecurityScrubber {
    private static instance;
    private scrubbingConfig;
    private piiConfig;
    private destroyed;
    private sensitiveHeaders;
    private sensitiveFields;
    private static readonly EMAIL_PATTERN;
    private static readonly PHONE_PATTERN;
    private static readonly IPV4_PATTERN;
    private constructor();
    static initialize(config: PrivacyConfig): SecurityScrubber;
    static getInstance(): SecurityScrubber | null;
    /**
     * Scrub an event. Returns a new event with sensitive data redacted.
     * Never mutates the original event. Never throws.
     */
    scrub<T extends SDKEvent>(event: T): T;
    /** Handle config change — hot-swap privacy config. */
    handleConfigChange(_diff: ConfigDiff, newConfig: Readonly<RemoteConfigResponse>): void;
    /**
     * Object keys we refuse to copy to scrubbed output. Even though the input
     * arrives via structuredClone (which doesn't preserve the magic
     * `__proto__` accessor), defense-in-depth: a future serialization
     * format change or a hand-crafted payload could include these as plain
     * own properties. Skipping them prevents prototype pollution from
     * downstream consumers that re-merge our output via Object.assign.
     */
    private static readonly DANGEROUS_KEYS;
    private scrubHeaders;
    private scrubQueryParams;
    private scrubUrlQueryString;
    private scrubBodyFields;
    private scrubPiiInObject;
    private scrubPiiInString;
    destroy(): void;
    static reset(): void;
}
//# sourceMappingURL=security-scrubber.d.ts.map