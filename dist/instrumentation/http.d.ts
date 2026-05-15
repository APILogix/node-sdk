/**
 * HTTP Client Instrumentation — automatically traces outbound HTTP/HTTPS requests.
 *
 * Wraps Node.js native http.request and https.request to:
 * - Create child spans for each outbound HTTP call
 * - Inject W3C trace context headers (traceparent/tracestate)
 * - Record request/response attributes per OTel semantic conventions
 * - Capture errors and timeouts
 * - Add breadcrumbs for each outbound call
 *
 * Usage:
 *   import { instrumentHttpClient } from '@vikasbaplawat1/pulse-sdk'
 *   instrumentHttpClient() // call once during app startup
 */
/**
 * Patch Node.js http/https modules to automatically trace outbound requests.
 * Idempotent — safe to call multiple times.
 */
export declare function instrumentHttpClient(): void;
/**
 * Reset instrumentation state — for testing.
 * @internal
 */
export declare function resetHttpInstrumentation(): void;
//# sourceMappingURL=http.d.ts.map