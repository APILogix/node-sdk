/**
 * API Payload Scrubber — enterprise-grade PII and sensitive data redaction.
 *
 * Provides configurable redaction for:
 * - Specific API payload fields (headers, query parameters, request/response bodies)
 * - Deep object scrubbing via recursive property traversal
 * - String sanitization using PII detection patterns
 */
import type { SDKEvent } from '../types/event.js';
export interface ScrubberConfig {
    sensitiveHeaders?: string[];
    sensitiveKeys?: string[];
    redactRequestBody?: boolean;
    redactResponseBody?: boolean;
}
declare class ApiPayloadScrubber {
    private customHeaders;
    private customKeysPattern;
    private redactRequestBody;
    private redactResponseBody;
    configure(config?: ScrubberConfig): void;
    /**
     * Main entry point for the event pipeline.
     * Deep-scrubs PII and explicitly governs API payloads (headers, query, bodies).
     */
    sanitizeEvent(event: SDKEvent): SDKEvent;
    private scrubRequestEvent;
    private scrubSpanEvent;
    /**
     * Sanitize HTTP headers explicitly.
     */
    sanitizeHeaders(headers: Readonly<Record<string, unknown>>): Record<string, unknown>;
    private isSensitiveHeader;
    private isSensitiveKey;
    private sanitizeValue;
    private sanitizeObject;
    private sanitizeString;
}
export declare const apiPayloadScrubber: ApiPayloadScrubber;
export declare function sanitizeEvent(event: SDKEvent): SDKEvent;
export declare function sanitizeHeaders(headers: Readonly<Record<string, unknown>>): Record<string, unknown>;
export {};
