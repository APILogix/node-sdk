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
}
/**
 * Register OpenTelemetry auto-instrumentations with Pulse SDK guards.
 * Idempotent — safe to call multiple times.
 */
export declare function registerAutoInstrumentations(options?: AutoInstrumentOptions): void;
/**
 * Reset auto-instrumentation state — for testing.
 * @internal
 */
export declare function resetAutoInstrumentations(): void;
//# sourceMappingURL=auto-instrument.d.ts.map