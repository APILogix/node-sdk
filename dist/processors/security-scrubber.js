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
import { isIP } from 'node:net';
const REDACTED = '[Redacted]';
const SYSTEM_ID_KEYS = new Set(['traceId', 'spanId', 'parentSpanId', 'eventId']);
export class SecurityScrubber {
    static instance = null;
    scrubbingConfig;
    piiConfig;
    destroyed = false;
    hasScrubRules = false;
    // Pre-compiled sets for O(1) lookups. Headers and the unified `fields`
    // list each get their own lowercased Set so callers can avoid recomputing
    // them on every event.
    sensitiveHeaders;
    sensitiveFields;
    normalizedHeaders;
    normalizedFields;
    keySensitivityCache = new Map();
    static MAX_CACHE_SIZE = 2000;
    // PII patterns
    static EMAIL_PATTERN = /(?<![a-zA-Z0-9._%+-])[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
    static PHONE_PATTERN = /(?<![a-zA-Z0-9])(\+?1?\s*[-.\s]?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4})(?![a-zA-Z0-9])/g;
    static IPV4_PATTERN = /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g;
    static BRACKETED_IPV6_PATTERN = /\[([0-9A-Fa-f:.]+)(%[0-9A-Za-z_.-]+)?\](?::\d{1,5})?/g;
    static IPV6_CANDIDATE_PATTERN = /(?<![0-9A-Za-z])([0-9A-Fa-f:.]+(?:%[0-9A-Za-z_.-]+)?)(?![0-9A-Za-z])/g;
    // Credit Card Primary Account Numbers: 13-19 digits, formatted (4-4-4-4, 4-6-5) or contiguous
    static CREDIT_CARD_PATTERN = /(?<!\d)(?:\d{4}[-\s]\d{4}[-\s]\d{4}[-\s]\d{1,4}|\d{4}[-\s]\d{6}[-\s]\d{4,5}|\d{13,19})(?!\d)/g;
    // US Social Security Numbers (Area != 000, 666, 900-999; Group != 00; Serial != 0000)
    static SSN_PATTERN = /(?<!\d)(?!000|666|9\d{2})(\d{3})[- ](?!00)(\d{2})[- ](?!0000)(\d{4})(?!\d)/g;
    /**
     * Validate a credit card Primary Account Number (PAN) using the Luhn mod-10 algorithm.
     */
    static isValidLuhn(digits) {
        if (digits.length < 13 || digits.length > 19)
            return false;
        let sum = 0;
        let shouldDouble = false;
        for (let i = digits.length - 1; i >= 0; i--) {
            let digit = parseInt(digits.charAt(i), 10);
            if (Number.isNaN(digit))
                return false;
            if (shouldDouble) {
                digit *= 2;
                if (digit > 9)
                    digit -= 9;
            }
            sum += digit;
            shouldDouble = !shouldDouble;
        }
        return sum % 10 === 0;
    }
    constructor(config) {
        this.scrubbingConfig = { ...config.scrubbing };
        this.piiConfig = { ...config.piiDetection };
        this.sensitiveHeaders = new Set(config.scrubbing.headers.map((h) => h.toLowerCase()));
        this.sensitiveFields = new Set(config.scrubbing.fields.map((f) => f.toLowerCase()));
        this.normalizedHeaders = new Set(config.scrubbing.headers.map((h) => h.toLowerCase().replace(/[-_]/g, '')));
        this.normalizedFields = new Set(config.scrubbing.fields.map((f) => f.toLowerCase().replace(/[-_]/g, '')));
        this.updateHasScrubRules();
    }
    getPrivacyConfig() {
        return {
            capture: { headers: true, body: true, response: false, query: true, cookies: false },
            scrubbing: {
                enabled: this.scrubbingConfig.enabled,
                headers: [...this.sensitiveHeaders],
                fields: [...this.sensitiveFields],
            },
            piiDetection: { ...this.piiConfig },
        };
    }
    updateHasScrubRules() {
        const hasPii = this.piiConfig.enabled && (this.piiConfig.maskEmails ||
            this.piiConfig.maskPhones ||
            this.piiConfig.maskIPs ||
            this.piiConfig.maskCreditCards !== false ||
            this.piiConfig.maskSSNs !== false);
        this.hasScrubRules = !!((this.scrubbingConfig.enabled && (this.sensitiveHeaders.size > 0 || this.sensitiveFields.size > 0)) ||
            hasPii);
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
        if (this.destroyed || !this.hasScrubRules)
            return event;
        try {
            const clone = { ...event };
            const hasHeaderRules = this.scrubbingConfig.enabled && this.sensitiveHeaders.size > 0;
            const hasFieldRules = this.scrubbingConfig.enabled && this.sensitiveFields.size > 0;
            const hasPiiRules = this.piiConfig.enabled && (this.piiConfig.maskEmails ||
                this.piiConfig.maskPhones ||
                this.piiConfig.maskIPs ||
                this.piiConfig.maskCreditCards !== false ||
                this.piiConfig.maskSSNs !== false);
            const needsDeepScrub = hasFieldRules || hasHeaderRules || hasPiiRules;
            // Shallow clone objects that we'll mutate — but only when we actually
            // have rules that require inspecting them. Previously these clones
            // ran unconditionally, wasting CPU and allocations for large payloads
            // when only header scrubbing was configured.
            if (hasHeaderRules && 'headers' in clone && typeof clone['headers'] === 'object' && clone['headers'] !== null) {
                clone['headers'] = { ...clone['headers'] };
            }
            if (hasFieldRules && 'query' in clone && typeof clone['query'] === 'object' && clone['query'] !== null) {
                clone['query'] = { ...clone['query'] };
            }
            if (needsDeepScrub) {
                if ('context' in clone && typeof clone['context'] === 'object' && clone['context'] !== null) {
                    clone['context'] = { ...clone['context'] };
                }
                if ('attributes' in clone && typeof clone['attributes'] === 'object' && clone['attributes'] !== null) {
                    clone['attributes'] = { ...clone['attributes'] };
                }
                if ('body' in clone && typeof clone['body'] === 'object' && clone['body'] !== null && !Array.isArray(clone['body'])) {
                    clone['body'] = { ...clone['body'] };
                }
            }
            // Scrub headers
            if (hasHeaderRules && 'headers' in clone && typeof clone['headers'] === 'object' && clone['headers'] !== null) {
                clone['headers'] = this.scrubHeaders(clone['headers']);
            }
            // Scrub query params
            if (hasFieldRules && 'query' in clone && typeof clone['query'] === 'object' && clone['query'] !== null) {
                clone['query'] = this.scrubQueryParams(clone['query']);
            }
            // Scrub URL query string
            if (hasFieldRules && 'url' in clone && typeof clone['url'] === 'string') {
                clone['url'] = this.scrubUrlQueryString(clone['url']);
            }
            // Deep-copy and scrub every payload section, including scope-provided
            // `extra`, `contexts`, `rootSpan`, and embedded `spans`. This prevents sensitive keys from escaping
            // merely because a new event field was added, and preserves caller
            // immutability for nested objects/arrays.
            if (needsDeepScrub) {
                for (const [key, value] of Object.entries(clone)) {
                    if (key === 'metadata' || SYSTEM_ID_KEYS.has(key) || SecurityScrubber.DANGEROUS_KEYS.has(key)) {
                        if (SecurityScrubber.DANGEROUS_KEYS.has(key))
                            delete clone[key];
                        continue;
                    }
                    clone[key] = this.scrubValue(value);
                }
            }
            return clone;
        }
        catch (err) {
            getLogger().warn(`[SecurityScrubber] Error during scrubbing: ${err instanceof Error ? err.message : String(err)}`);
            return stripSensitiveSections(event);
        }
    }
    scrubBatch(events) {
        if (this.destroyed || !this.hasScrubRules)
            return events;
        return events.map(e => this.scrub(e));
    }
    /**
     * Determine if a field or attribute key matches sensitive field/header rules.
     * Checks full key as well as trailing component (e.g. `http.request.header.authorization` -> `authorization`).
     */
    isKeySensitive(rawKey) {
        if (!this.scrubbingConfig.enabled)
            return false;
        const cached = this.keySensitivityCache.get(rawKey);
        if (cached !== undefined)
            return cached;
        const key = rawKey.toLowerCase();
        let isSensitive = false;
        if (this.sensitiveFields.has(key) || this.sensitiveHeaders.has(key)) {
            isSensitive = true;
        }
        else {
            const normalized = key.replace(/[-_]/g, '');
            if (this.normalizedFields.has(normalized) || this.normalizedHeaders.has(normalized)) {
                isSensitive = true;
            }
            else {
                const parts = key.split(/[\.:]/);
                const lastPart = parts[parts.length - 1];
                if (lastPart && (this.sensitiveFields.has(lastPart) || this.sensitiveHeaders.has(lastPart))) {
                    isSensitive = true;
                }
                else {
                    // Check compound names (camelCase, snake_case, etc.)
                    const wordTokens = rawKey
                        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
                        .toLowerCase()
                        .split(/[^a-z0-9]+/)
                        .filter(Boolean);
                    const nonSecretTokenIndicators = new Set(['count', 'total', 'usage', 'prompt', 'completion', 'consumed', 'balance', 'remaining']);
                    const hasCountIndicator = wordTokens.some(w => nonSecretTokenIndicators.has(w));
                    for (const w of wordTokens) {
                        if (this.sensitiveFields.has(w) || this.sensitiveHeaders.has(w)) {
                            if (w === 'token' && hasCountIndicator) {
                                continue;
                            }
                            isSensitive = true;
                            break;
                        }
                    }
                }
            }
        }
        if (this.keySensitivityCache.size >= SecurityScrubber.MAX_CACHE_SIZE) {
            const oldestKey = this.keySensitivityCache.keys().next().value;
            if (oldestKey !== undefined)
                this.keySensitivityCache.delete(oldestKey);
        }
        this.keySensitivityCache.set(rawKey, isSensitive);
        return isSensitive;
    }
    /**
     * Scrub an arbitrary value (object, array, or string) with the active
     * field-redaction and PII rules. Used for payload sections that are not
     * part of the fixed event shape — e.g. `LogEvent.args`,
     * `ReplayEvent.events`, profile payloads, aggregated trace spans. Returns a new value; never
     * mutates the input. Never throws.
     */
    scrubValue(value, depth = 0) {
        if (this.destroyed || !this.hasScrubRules)
            return value;
        if (depth > 10)
            return REDACTED;
        try {
            if (typeof value === 'string') {
                let str = value;
                if (this.scrubbingConfig.enabled &&
                    str.length >= 2 &&
                    str.length <= 64 * 1024 &&
                    ((str.startsWith('{') && str.endsWith('}')) || (str.startsWith('[') && str.endsWith(']')))) {
                    try {
                        const parsed = JSON.parse(str);
                        if (typeof parsed === 'object' && parsed !== null) {
                            return JSON.stringify(this.scrubValue(parsed, depth + 1));
                        }
                    }
                    catch {
                        // Not valid JSON, continue with string pattern scrubbing
                    }
                }
                if (this.piiConfig.enabled) {
                    str = this.scrubPiiInString(str);
                }
                if (this.scrubbingConfig.enabled) {
                    str = str.replace(/Bearer\s+[A-Za-z0-9_\-\.]+/gi, 'Bearer [Redacted]');
                    str = str.replace(/Basic\s+[A-Za-z0-9+/=]{10,}/gi, 'Basic [Redacted]');
                    str = str.replace(/eyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/g, '[Redacted]');
                    str = str.replace(/\b(sk_live_[0-9a-zA-Z]{24,}|pk_live_[0-9a-zA-Z]{24,}|rk_live_[0-9a-zA-Z]{24,})\b/g, '[Redacted]');
                    str = str.replace(/\b(AKIA[0-9A-Z]{16})\b/g, '[Redacted]');
                    str = str.replace(/\b(bearer[-_]token|token[-_]bearer|bearer)[-_][A-Za-z0-9_\-\.]+\b/gi, '[Redacted]');
                    str = str.replace(/\b(api[-_]?key|api[-_]?secret|access[-_]?token|refresh[-_]?token|client[-_]?secret|password|secret|token|authorization|x-api-key|x-auth-token)\s*([:=])\s*([^\s&,;"']+)/gi, '$1$2[Redacted]');
                    str = str.replace(/\b(token|secret|password|api[-_]?key)\s+([A-Za-z0-9_\-\.]{8,})/gi, (match, prefix, tokenVal) => {
                        const commonWords = new Set(['expired', 'invalid', 'missing', 'revoked', 'required', 'rejected', 'failed', 'not', 'found', 'cannot', 'could', 'should', 'would', 'error', 'format', 'length', 'expected', 'provided']);
                        if (commonWords.has(tokenVal.toLowerCase()) && /^[a-z]+$/i.test(tokenVal)) {
                            return match;
                        }
                        return `${prefix} [Redacted]`;
                    });
                }
                return str;
            }
            if (Array.isArray(value)) {
                return value.map(item => this.scrubValue(item, depth + 1));
            }
            if (typeof value === 'object' && value !== null) {
                const result = Object.create(null);
                for (const [key, v] of Object.entries(value)) {
                    if (SecurityScrubber.DANGEROUS_KEYS.has(key))
                        continue;
                    if (SYSTEM_ID_KEYS.has(key)) {
                        result[key] = v;
                    }
                    else if (this.isKeySensitive(key)) {
                        result[key] = REDACTED;
                    }
                    else {
                        result[key] = this.scrubValue(v, depth + 1);
                    }
                }
                return result;
            }
            if (typeof value === 'bigint')
                return value.toString();
            return value;
        }
        catch {
            return REDACTED;
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
        this.normalizedHeaders = new Set(newPrivacy.scrubbing.headers.map((h) => h.toLowerCase().replace(/[-_]/g, '')));
        this.normalizedFields = new Set(newPrivacy.scrubbing.fields.map((f) => f.toLowerCase().replace(/[-_]/g, '')));
        this.keySensitivityCache.clear();
        this.updateHasScrubRules();
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
            if (parsed.username || parsed.password) {
                if (parsed.username)
                    parsed.username = REDACTED;
                if (parsed.password)
                    parsed.password = REDACTED;
                changed = true;
            }
            for (const [param] of Array.from(parsed.searchParams.entries())) {
                if (this.isKeySensitive(param)) {
                    parsed.searchParams.set(param, REDACTED);
                    changed = true;
                }
            }
            let res = changed ? parsed.toString() : url;
            if (this.piiConfig.enabled) {
                res = this.scrubPiiInString(res);
            }
            return res;
        }
        catch {
            return this.piiConfig.enabled ? this.scrubPiiInString(url) : url;
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
            else if (typeof value === 'object' && value !== null) {
                // Arrays (e.g. LogEvent.args, ReplayEvent.events, profile nodes)
                // are traversed item-by-item; objects inside arrays are scrubbed
                // recursively. Scalars pass through untouched.
                result[key] = Array.isArray(value)
                    ? value.map(item => typeof item === 'object' && item !== null
                        ? Array.isArray(item)
                            ? this.scrubValue(item, depth + 1)
                            : this.scrubBodyFields(item, depth + 1)
                        : item)
                    : this.scrubBodyFields(value, depth + 1);
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
            else if (typeof value === 'object' && value !== null) {
                if (Array.isArray(value)) {
                    // Copy-on-write: arrays live on a shallow clone, so scrubbing in
                    // place would mutate the caller's original event. Produce a new
                    // array (and shallow copies of object items) instead.
                    obj[key] = this.scrubPiiInArray(value, depth + 1);
                }
                else {
                    this.scrubPiiInObject(value, depth + 1);
                }
            }
        }
    }
    scrubPiiInArray(arr, depth = 0) {
        if (depth > 10)
            return arr;
        return arr.map(item => {
            if (typeof item === 'string') {
                return this.scrubPiiInString(item);
            }
            if (Array.isArray(item)) {
                return this.scrubPiiInArray(item, depth + 1);
            }
            if (typeof item === 'object' && item !== null) {
                const copy = { ...item };
                this.scrubPiiInObject(copy, depth + 1);
                return copy;
            }
            return item;
        });
    }
    scrubPiiInString(str) {
        let result = str;
        // Credit Card Primary Account Number (PAN) scrubbing with Luhn validation
        if (this.piiConfig.maskCreditCards !== false) {
            result = result.replace(SecurityScrubber.CREDIT_CARD_PATTERN, (match) => {
                const raw = match.replace(/[-\s]/g, '');
                if (raw.length >= 13 && raw.length <= 19 && SecurityScrubber.isValidLuhn(raw)) {
                    return REDACTED;
                }
                return match;
            });
        }
        // US Social Security Number (SSN) scrubbing
        if (this.piiConfig.maskSSNs !== false) {
            result = result.replace(SecurityScrubber.SSN_PATTERN, REDACTED);
        }
        if (this.piiConfig.maskEmails) {
            result = result.replace(SecurityScrubber.EMAIL_PATTERN, '[email]');
        }
        if (this.piiConfig.maskPhones) {
            result = result.replace(SecurityScrubber.PHONE_PATTERN, '[phone]');
        }
        if (this.piiConfig.maskIPs) {
            result = result.replace(SecurityScrubber.BRACKETED_IPV6_PATTERN, (candidate, address) => isIP(address) === 6 ? '[ip]' : candidate);
            result = result.replace(SecurityScrubber.IPV6_CANDIDATE_PATTERN, (candidate) => {
                const address = candidate.includes('%') ? candidate.slice(0, candidate.indexOf('%')) : candidate;
                // Colon-delimited times and MAC addresses are not treated as IPs,
                // even where a permissive parser might consider them abbreviated IPv6.
                if (/^\d{1,2}:\d{2}:\d{2}$/.test(address) || /^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(address)) {
                    return candidate;
                }
                return isIP(address) === 6 ? '[ip]' : candidate;
            });
            result = result.replace(SecurityScrubber.IPV4_PATTERN, '[ip]');
        }
        return result;
    }
    destroy() {
        this.destroyed = true;
        this.keySensitivityCache.clear();
        SecurityScrubber.instance = null;
    }
    static reset() {
        if (SecurityScrubber.instance) {
            SecurityScrubber.instance.destroy();
        }
    }
}
function stripSensitiveSections(event) {
    const clone = { ...event };
    for (const key of [
        'headers', 'query', 'body', 'response', 'cookies', 'context', 'attributes',
        'tags', 'extra', 'contexts', 'user', 'breadcrumbs',
    ]) {
        delete clone[key];
    }
    if ('args' in clone)
        clone['args'] = [];
    if ('events' in clone)
        clone['events'] = [];
    if ('profile' in clone)
        clone['profile'] = REDACTED;
    if ('stack' in clone)
        clone['stack'] = [];
    if (typeof clone['message'] === 'string')
        clone['message'] = REDACTED;
    if (typeof clone['url'] === 'string')
        clone['url'] = clone['url'].split('?')[0] ?? '';
    return clone;
}
