/**
 * Event sanitizer — deep PII scrubbing across all event fields.
 *
 * Redacts:
 * - Sensitive header values (authorization, cookie, api-key, etc.)
 * - PII patterns in string values (emails, credit cards, SSNs, phone numbers)
 * - Sensitive key names at any depth (password, token, secret, etc.)
 *
 * Configurable via custom patterns.
 */
import type { SDKEvent } from '../types/event.js';
/**
 * Sanitize an entire event — deep-scrubs all PII and sensitive fields.
 */
export declare function sanitizeEvent(event: SDKEvent): SDKEvent;
/**
 * Sanitize HTTP headers — redacts sensitive header values.
 */
export declare function sanitizeHeaders(headers: Readonly<Record<string, unknown>>): Record<string, unknown>;
//# sourceMappingURL=sanitizer.d.ts.map