/**
 * Compatibility shim.
 *
 * HTTP tracing is owned by OpenTelemetry HttpInstrumentation and
 * UndiciInstrumentation. This function intentionally does not monkey-patch
 * node:http or node:https, preventing duplicate spans and recursive SDK
 * self-instrumentation.
 */
/**
 * @deprecated HTTP tracing is fully owned by OpenTelemetry HttpInstrumentation.
 * This function is a no-op retained for backward compatibility.
 * Remove calls to this function — OpenTelemetry handles HTTP tracing automatically.
 */
export declare function instrumentHttpClient(): void;
export declare function resetHttpInstrumentation(): void;
//# sourceMappingURL=http.d.ts.map