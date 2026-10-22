/**
 * W3C Trace Context Propagation — extracts and injects trace context
 * from/into HTTP headers following the W3C specification.
 *
 * Uses native OpenTelemetry propagation APIs (`propagation.extract`,
 * `propagation.inject`) rather than manual traceparent parsing so that
 * OTel samplers, propagators, and context managers remain in control.
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
 * Export header constants for use by instrumentation modules.
 */
export declare const TRACE_HEADERS: {
    readonly TRACEPARENT: "traceparent";
    readonly TRACESTATE: "tracestate";
    readonly LYNKTRACE_TRACE_ID: "x-lynktrace-trace-id";
    readonly LYNKTRACE_SPAN_ID: "x-lynktrace-span-id";
    readonly LYNKTRACE_SAMPLED: "x-lynktrace-sampled";
    readonly PULSE_TRACE_ID: "x-pulse-trace-id";
    readonly PULSE_SPAN_ID: "x-pulse-span-id";
    readonly PULSE_SAMPLED: "x-pulse-sampled";
};
