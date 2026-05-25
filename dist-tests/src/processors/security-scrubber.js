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
import { getLogger } from '../utils/logger.js';
const REDACTED = '[Redacted]';
export class SecurityScrubber {
    static instance = null;
    scrubbingConfig;
    piiConfig;
    destroyed = false;
    // Pre-compiled sets for O(1) lookups. Headers and the unified `fields`
    // list each get their own lowercased Set so callers can avoid recomputing
    // them on every event.
    sensitiveHeaders;
    sensitiveFields;
    // PII patterns
    static EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
    static PHONE_PATTERN = /(\+?1?\s*[-.\s]?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4})/g;
    static IPV4_PATTERN = /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g;
    constructor(config) {
        this.scrubbingConfig = { ...config.scrubbing };
        this.piiConfig = { ...config.piiDetection };
        this.sensitiveHeaders = new Set(config.scrubbing.headers.map((h) => h.toLowerCase()));
        this.sensitiveFields = new Set(config.scrubbing.fields.map((f) => f.toLowerCase()));
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
            // Scrub body fields in context/attributes/body
            if ('context' in clone && typeof clone['context'] === 'object' && clone['context'] !== null) {
                clone['context'] = this.scrubBodyFields(clone['context']);
            }
            if ('attributes' in clone && typeof clone['attributes'] === 'object' && clone['attributes'] !== null) {
                clone['attributes'] = this.scrubBodyFields(clone['attributes']);
            }
            if ('body' in clone && typeof clone['body'] === 'object' && clone['body'] !== null && !Array.isArray(clone['body'])) {
                clone['body'] = this.scrubBodyFields(clone['body']);
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
    /** Handle config change — hot-swap privacy config. */
    handleConfigChange(_diff, newConfig) {
        if (this.destroyed)
            return;
        const newPrivacy = newConfig.privacy;
        this.scrubbingConfig = { ...newPrivacy.scrubbing };
        this.piiConfig = { ...newPrivacy.piiDetection };
        this.sensitiveHeaders = new Set(newPrivacy.scrubbing.headers.map((h) => h.toLowerCase()));
        this.sensitiveFields = new Set(newPrivacy.scrubbing.fields.map((f) => f.toLowerCase()));
        getLogger().info('[SecurityScrubber] Config updated');
    }
    // ─── Private Scrubbing Methods ────────────────────────────────────────────
    /**
     * Object keys we refuse to copy to scrubbed output. Even though the input
     * arrives via structuredClone (which doesn't preserve the magic
     * `__proto__` accessor), defense-in-depth: a future serialization
     * format change or a hand-crafted payload could include these as plain
     * own properties. Skipping them prevents prototype pollution from
     * downstream consumers that re-merge our output via Object.assign.
     */
    static DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
    scrubHeaders(headers) {
        const result = Object.create(null);
        for (const [key, value] of Object.entries(headers)) {
            if (SecurityScrubber.DANGEROUS_KEYS.has(key))
                continue;
            result[key] = this.sensitiveHeaders.has(key.toLowerCase()) ? REDACTED : value;
        }
        return result;
    }
    scrubQueryParams(query) {
        const result = Object.create(null);
        for (const [key, value] of Object.entries(query)) {
            if (SecurityScrubber.DANGEROUS_KEYS.has(key))
                continue;
            result[key] = this.sensitiveFields.has(key.toLowerCase()) ? REDACTED : value;
        }
        return result;
    }
    scrubUrlQueryString(url) {
        try {
            const parsed = new URL(url, 'http://localhost');
            let changed = false;
            for (const param of this.sensitiveFields) {
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
        const result = Object.create(null);
        for (const [key, value] of Object.entries(obj)) {
            if (SecurityScrubber.DANGEROUS_KEYS.has(key))
                continue;
            if (this.sensitiveFields.has(key.toLowerCase())) {
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
            if (SecurityScrubber.DANGEROUS_KEYS.has(key))
                continue;
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
