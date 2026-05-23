/**
 * Axios Instrumentation — OpenTelemetry-compatible HTTP client instrumentation
 * wrapped with Pulse SDK guards and remote config support.
 *
 * Axios is an HTTP client that wraps node:http/https. This instrumentation
 * ensures axios requests are properly traced with axios-specific attributes.
 *
 * Features:
 * - Automatic span creation for axios requests
 * - Request/response interceptors for tracing
 * - Axios-specific span attributes (config, headers)
 * - Error tracking with response context
 * - Request timeout tracking
 * - Multipart form data handling
 *
 * Note: Since axios uses node:http/https internally, the OTel HttpInstrumentation
 * already captures these requests. This module adds axios-specific attributes
 * and ensures proper span naming conventions.
 */
import type { TracingCaptureConfig } from '../types/config.js';
export interface AxiosInstrumentationOptions {
    enabled: boolean;
    captureRequestData?: boolean;
    captureResponseData?: boolean;
    requestTimeout?: number;
    maxBodySize?: number;
}
export declare function createAxiosInstrumentation(enabled: boolean, mergedOptions?: Partial<AxiosInstrumentationOptions>, captureConfig?: TracingCaptureConfig): {
    setup: () => void;
    teardown: () => void;
} | null;
export interface AxiosSpanAttributes {
    'http.method': string;
    'http.url': string;
    'http.host': string;
    'http.scheme': string;
    'http.user_agent': 'axios';
    'http.status_code': number;
    'http.axios.request_timeout': number;
    'http.request.headers'?: string;
    'http.response.headers'?: string;
    'http.request.query'?: string;
    'http.response.body'?: string;
}
export default createAxiosInstrumentation;
//# sourceMappingURL=axios.d.ts.map