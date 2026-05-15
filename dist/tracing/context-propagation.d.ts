/**
 * W3C Trace Context Propagation — extracts and injects trace context
 * from/into HTTP headers following the W3C specification.
 *
 * Supports:
 * - traceparent header (W3C Trace Context)
 * - tracestate header (vendor-specific baggage)
 * - Custom Pulse SDK headers (X-Pulse-Trace-Id, X-Pulse-Span-Id)
 *
 * This enables distributed tracing across service boundaries.
 */
import { type Context, type TextMapGetter, type TextMapSetter } from '@opentelemetry/api';
/**
 * Standard getter for extracting headers from an incoming request.
 * Works with plain objects and case-insensitive headers.
 */
export declare const headerGetter: TextMapGetter<Record<string, string | string[] | undefined>>;
/**
 * Standard setter for injecting headers into an outgoing request.
 */
export declare const headerSetter: TextMapSetter<Record<string, string>>;
/**
 * Extract trace context from incoming HTTP headers.
 * Returns an OTel Context with the extracted span context.
 *
 * @param headers - Incoming request headers (case-insensitive)
 * @returns OTel Context with propagated trace info
 */
export declare function extractTraceContext(headers: Record<string, string | string[] | undefined>): Context;
/**
 * Inject trace context into outgoing HTTP headers.
 * Adds W3C traceparent/tracestate and Pulse custom headers.
 *
 * @param headers - Mutable headers object to inject into
 * @param ctx - Optional OTel context (defaults to active context)
 */
export declare function injectTraceContext(headers: Record<string, string>, ctx?: Context): void;
/**
 * Parse a traceparent header string into its components.
 *
 * Format: {version}-{trace-id}-{parent-id}-{trace-flags}
 * Example: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
 */
export declare function parseTraceparent(traceparent: string): {
    version: string;
    traceId: string;
    parentId: string;
    traceFlags: number;
} | null;
/**
 * Create a W3C traceparent header value.
 */
export declare function createTraceparent(traceId: string, spanId: string, sampled?: boolean): string;
/**
 * Export header constants for use by instrumentation modules.
 */
export declare const TRACE_HEADERS: {
    readonly TRACEPARENT: "traceparent";
    readonly TRACESTATE: "tracestate";
    readonly PULSE_TRACE_ID: "x-pulse-trace-id";
    readonly PULSE_SPAN_ID: "x-pulse-span-id";
    readonly PULSE_SAMPLED: "x-pulse-sampled";
};
//# sourceMappingURL=context-propagation.d.ts.map