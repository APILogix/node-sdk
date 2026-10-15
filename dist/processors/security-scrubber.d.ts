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
    private captureConfig;
    private scrubbingConfig;
    private piiConfig;
    private destroyed;
    private hasScrubRules;
    private sensitiveHeaders;
    private sensitiveFields;
    private normalizedHeaders;
    private normalizedFields;
    private readonly keySensitivityCache;
    private static readonly MAX_CACHE_SIZE;
    private static readonly EMAIL_PATTERN;
    private static readonly PHONE_PATTERN;
    private static readonly IPV4_PATTERN;
    private static readonly BRACKETED_IPV6_PATTERN;
    private static readonly IPV6_CANDIDATE_PATTERN;
    private static readonly CREDIT_CARD_PATTERN;
    private static readonly SSN_PATTERN;
    /**
     * Validate a credit card Primary Account Number (PAN) using the Luhn mod-10 algorithm.
     */
    static isValidLuhn(digits: string): boolean;
    private constructor();
    getPrivacyConfig(): PrivacyConfig;
    private updateHasScrubRules;
    static initialize(config: PrivacyConfig): SecurityScrubber;
    static getInstance(): SecurityScrubber | null;
    /**
     * Scrub an event. Returns a new event with sensitive data redacted.
     * Never mutates the original event. Never throws.
     */
    scrub<T extends SDKEvent>(event: T): T;
    scrubBatch<T extends SDKEvent>(events: T[]): T[];
    /**
     * Determine if a field or attribute key matches sensitive field/header rules.
     * Checks full key as well as trailing component (e.g. `http.request.header.authorization` -> `authorization`).
     */
    private isKeySensitive;
    /**
     * Scrub an arbitrary value (object, array, or string) with the active
     * field-redaction and PII rules. Used for payload sections that are not
     * part of the fixed event shape — e.g. `LogEvent.args`,
     * `ReplayEvent.events`, profile payloads, aggregated trace spans. Returns a new value; never
     * mutates the input. Never throws.
     */
    scrubValue(value: unknown, depth?: number, seen?: WeakSet<object>): unknown;
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
    private scrubPiiInArray;
    private scrubPiiInString;
    destroy(): void;
    static reset(): void;
}
