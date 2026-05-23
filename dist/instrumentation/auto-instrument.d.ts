/**
 * Auto Instrumentation — selective OpenTelemetry instrumentations
 * wrapped with Pulse SDK guards to prevent duplicate spans and
 * recursive SDK tracing.
 *
 * Provides:
 * - HTTP client instrumentation (http/https/fetch/undici)
 * - Express framework instrumentation
 * - Self-request guard (prevents tracing SDK's own ingestion calls)
 * - No duplicate spans (OTel SDK handles deduplication)
 * - Low-overhead runtime performance
 *
 * Architecture:
 *   OTel Instrumentation → Pulse SpanProcessor → PipelineSpanExporter → EventPipeline
 */
export interface AutoInstrumentOptions {
    /** Enable HTTP client auto-instrumentation. Default: true */
    http?: boolean;
    /** Enable Express auto-instrumentation. Default: true */
    express?: boolean;
    /** Enable Fastify auto-instrumentation. Default: true */
    fastify?: boolean;
    /** Enable Undici/fetch auto-instrumentation. Default: true */
    undici?: boolean;
}
/**
 * Register OpenTelemetry auto-instrumentations with Pulse SDK guards.
 * Idempotent — safe to call multiple times, even across multiple SDK copies
 * in the same V8 isolate (uses Symbol.for global guard).
 */
export declare function registerAutoInstrumentations(options?: AutoInstrumentOptions): void;
/**
 * Reset auto-instrumentation state — for testing.
 * @internal
 */
export declare function resetAutoInstrumentations(): void;
//# sourceMappingURL=auto-instrument.d.ts.map