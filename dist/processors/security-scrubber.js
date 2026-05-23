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
import { getLogger } from '../utils/logger.js';
const REDACTED = '[Redacted]';
export class SecurityScrubber {
    static instance = null;
    scrubbingConfig;
    piiConfig;
    destroyed = false;
    // Pre-compiled sets for O(1) lookups
    sensitiveHeaders;
    sensitiveBodyFields;
    sensitiveQueryParams;
    // PII patterns
    static EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
    static PHONE_PATTERN = /(\+?1?\s*[-.\s]?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4})/g;
    static IPV4_PATTERN = /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g;
    constructor(config) {
        this.scrubbingConfig = { ...config.scrubbing };
        this.piiConfig = { ...config.piiDetection };
        this.sensitiveHeaders = new Set(config.scrubbing.headers.map(h => h.toLowerCase()));
        this.sensitiveBodyFields = new Set(config.scrubbing.bodyFields.map(f => f.toLowerCase()));
        this.sensitiveQueryParams = new Set(config.scrubbing.queryParams.map(p => p.toLowerCase()));
    }
    static initialize(config) {
        if (SecurityScrubber.instance) {
            SecurityScrubber.instance.destroy();
        }
        SecurityScrubber.instance = new SecurityScrubber(config);
        return SecurityScrubber.instance;
    }
    static getInstance() {
        return SecurityScrubber.instance;
    }
    /**
     * Scrub an event. Returns a new event with sensitive data redacted.
     * Never mutates the original event. Never throws.
     */
    scrub(event) {
        if (this.destroyed || !this.scrubbingConfig.enabled)
            return event;
        try {
            const clone = structuredClone(event);
            // Scrub headers
            if ('headers' in clone && typeof clone['headers'] === 'object' && clone['headers'] !== null) {
                clone['headers'] = this.scrubHeaders(clone['headers']);
            }
            // Scrub query params
            if ('query' in clone && typeof clone['query'] === 'object' && clone['query'] !== null) {
                clone['query'] = this.scrubQueryParams(clone['query']);
            }
            // Scrub URL query string
            if ('url' in clone && typeof clone['url'] === 'string') {
                clone['url'] = this.scrubUrlQueryString(clone['url']);
            }
            // Scrub body fields in context/attributes
            if ('context' in clone && typeof clone['context'] === 'object' && clone['context'] !== null) {
                clone['context'] = this.scrubBodyFields(clone['context']);
            }
            if ('attributes' in clone && typeof clone['attributes'] === 'object' && clone['attributes'] !== null) {
                clone['attributes'] = this.scrubBodyFields(clone['attributes']);
            }
            // PII detection on string fields
            if (this.piiConfig.enabled) {
                this.scrubPiiInObject(clone);
            }
            return clone;
        }
        catch (err) {
            getLogger().warn(`[SecurityScrubber] Error during scrubbing: ${err instanceof Error ? err.message : String(err)}`);
            return event; // Return original on error
        }
    }
    /** Handle config change — hot-swap security config. */
    handleConfigChange(_diff, newConfig) {
        if (this.destroyed)
            return;
        const newSecurity = newConfig.security;
        this.scrubbingConfig = { ...newSecurity.scrubbing };
        this.piiConfig = { ...newSecurity.piiDetection };
        this.sensitiveHeaders = new Set(newSecurity.scrubbing.headers.map(h => h.toLowerCase()));
        this.sensitiveBodyFields = new Set(newSecurity.scrubbing.bodyFields.map(f => f.toLowerCase()));
        this.sensitiveQueryParams = new Set(newSecurity.scrubbing.queryParams.map(p => p.toLowerCase()));
        getLogger().info('[SecurityScrubber] Config updated');
    }
    // ─── Private Scrubbing Methods ────────────────────────────────────────────
    scrubHeaders(headers) {
        const result = {};
        for (const [key, value] of Object.entries(headers)) {
            result[key] = this.sensitiveHeaders.has(key.toLowerCase()) ? REDACTED : value;
        }
        return result;
    }
    scrubQueryParams(query) {
        const result = {};
        for (const [key, value] of Object.entries(query)) {
            result[key] = this.sensitiveQueryParams.has(key.toLowerCase()) ? REDACTED : value;
        }
        return result;
    }
    scrubUrlQueryString(url) {
        try {
            const parsed = new URL(url, 'http://localhost');
            let changed = false;
            for (const param of this.sensitiveQueryParams) {
                if (parsed.searchParams.has(param)) {
                    parsed.searchParams.set(param, REDACTED);
                    changed = true;
                }
            }
            return changed ? parsed.toString() : url;
        }
        catch {
            return url;
        }
    }
    scrubBodyFields(obj, depth = 0) {
        if (depth > 10)
            return obj; // Prevent infinite recursion
        const result = {};
        for (const [key, value] of Object.entries(obj)) {
            if (this.sensitiveBodyFields.has(key.toLowerCase())) {
                result[key] = REDACTED;
            }
            else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
                result[key] = this.scrubBodyFields(value, depth + 1);
            }
            else {
                result[key] = value;
            }
        }
        return result;
    }
    scrubPiiInObject(obj, depth = 0) {
        if (depth > 10)
            return;
        for (const key of Object.keys(obj)) {
            const value = obj[key];
            if (typeof value === 'string') {
                obj[key] = this.scrubPiiInString(value);
            }
            else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
                this.scrubPiiInObject(value, depth + 1);
            }
        }
    }
    scrubPiiInString(str) {
        let result = str;
        if (this.piiConfig.maskEmails) {
            result = result.replace(SecurityScrubber.EMAIL_PATTERN, '[email]');
        }
        if (this.piiConfig.maskPhones) {
            result = result.replace(SecurityScrubber.PHONE_PATTERN, '[phone]');
        }
        if (this.piiConfig.maskIPs) {
            result = result.replace(SecurityScrubber.IPV4_PATTERN, '[ip]');
        }
        return result;
    }
    destroy() {
        this.destroyed = true;
        SecurityScrubber.instance = null;
    }
    static reset() {
        if (SecurityScrubber.instance) {
            SecurityScrubber.instance.destroy();
        }
    }
}
//# sourceMappingURL=security-scrubber.js.map