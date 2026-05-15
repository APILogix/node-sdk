/**
 * Request capture — captures HTTP request/response events.
 *
 * Delegates to the central event pipeline for normalization, sanitization,
 * sampling, and plugin processing.
 */
import type { RequestEvent } from '../types/event.js';
/**
 * Capture an HTTP request event.
 * Sampling is handled by the event pipeline — callers don't need to filter.
 */
export declare function captureRequest(event: RequestEvent): void;
//# sourceMappingURL=captureRequest.d.ts.map