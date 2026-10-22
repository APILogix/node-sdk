import type { PrivacyCaptureConfig } from '../types/config.js';
export declare const SUPPRESS_INNER_HTTP_LYNKTRACE: symbol;
export declare const SUPPRESS_INNER_HTTP: symbol;
export interface AxiosInstrumentationOptions {
    enabled: boolean;
    captureRequestData?: boolean;
    captureResponseData?: boolean;
    requestTimeout?: number;
    maxBodySize?: number;
}
export declare function createAxiosInstrumentation(enabled: boolean, mergedOptions?: Partial<AxiosInstrumentationOptions>, captureConfig?: PrivacyCaptureConfig): {
    setup: () => Promise<void>;
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
