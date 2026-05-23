/**
 * SecurityScrubber — enforces security.scrubbing and security.piiDetection config.
 *
 * Pre-transport processor that:
 * 1. Scrubs sensitive headers (authorization, cookie, etc.)
 * 2. Scrubs sensitive body fields (password, token, secret, etc.)
 * 3. Scrubs sensitive query parameters
 * 4. Detects and masks PII (emails, phones, IPs)
 *
 * All scrubbing is done on the event BEFORE it enters the transport queue.
 * The scrubber returns a new event — it never mutates the original.
 */
import type { SecurityConfig, ConfigDiff, RemoteConfigResponse } from '../types/config.js';
import type { SDKEvent } from '../types/event.js';
export declare class SecurityScrubber {
    private static instance;
    private scrubbingConfig;
    private piiConfig;
    private destroyed;
    private sensitiveHeaders;
    private sensitiveBodyFields;
    private sensitiveQueryParams;
    private static readonly EMAIL_PATTERN;
    private static readonly PHONE_PATTERN;
    private static readonly IPV4_PATTERN;
    private constructor();
    static initialize(config: SecurityConfig): SecurityScrubber;
    static getInstance(): SecurityScrubber | null;
    /**
     * Scrub an event. Returns a new event with sensitive data redacted.
     * Never mutates the original event. Never throws.
     */
    scrub<T extends SDKEvent>(event: T): T;
    /** Handle config change — hot-swap security config. */
    handleConfigChange(_diff: ConfigDiff, newConfig: Readonly<RemoteConfigResponse>): void;
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