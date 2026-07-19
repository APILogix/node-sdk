/**
 * HTTP transport — low-level POST with compression, signing, and rate-limit header parsing.
 */
import { type CompressionAlgorithm } from '../utils/compression.js';
export interface PostJsonOptions {
    /** Whether to log failures (disable for init to avoid noise). */
    logFailures?: boolean;
    /** Compression algorithm to use. Defaults to 'none'. */
    compression?: CompressionAlgorithm;
    /** Extra headers to include. */
    extraHeaders?: Record<string, string>;
}
export interface HttpResponse<T> {
    data: T;
    statusCode: number;
    retryAfterMs?: number;
    rateLimitRemaining?: number;
}
export declare function postJson<T>(url: string, body: unknown, headers: Record<string, string>, timeoutMs: number, options?: PostJsonOptions): Promise<T>;
//# sourceMappingURL=http.d.ts.map