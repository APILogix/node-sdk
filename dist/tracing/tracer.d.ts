/**
 * Pulse SDK Tracer — enterprise-grade distributed tracing built on OpenTelemetry.
 *
 * Provides:
 * - Singleton tracer management with lazy initialization
 * - Resource detection (service name, version, environment, host, OS)
 * - Configurable sampling (parent-based, ratio-based)
 * - Span creation with automatic context propagation
 * - Integration with SDK breadcrumbs and context store
 * - Graceful shutdown with pending span flush
 *
 * Architecture:
 *   PulseTracer → OTel NodeTracerProvider → SpanExporter → SDK EventPipeline
 *
 * The tracer sends spans through the SDK's event pipeline, so they benefit
 * from the same sanitization, plugin processing, and transport resilience
 * as all other SDK events.
 */
import { type Context } from '@opentelemetry/api';
import { PulseSpan, type SpanOptions } from './span.js';
import type { ResolvedSDKConfig } from '../types/config.js';
/**
 * Initialize the OpenTelemetry tracer provider.
 * Called during SDK init when `enableTracing: true`.
 *
 * Idempotent — safe to call multiple times.
 */
export declare function initTracer(config: ResolvedSDKConfig): void;
/**
 * Start a new span. Returns a PulseSpan wrapper.
 *
 * @param name - Span name (e.g. 'HTTP GET /api/users', 'db.query', 'cache.get')
 * @param options - Optional span configuration
 * @returns PulseSpan instance (or a no-op span if tracing is not initialized)
 */
export declare function startSpan(name: string, options?: SpanOptions): PulseSpan;
/**
 * Execute a function within a new span context.
 * The span is automatically ended when the function completes (or throws).
 *
 * @param name - Span name
 * @param fn - Function to execute within the span context
 * @param options - Optional span configuration
 * @returns The return value of the function
 */
export declare function withSpan<T>(name: string, fn: (span: PulseSpan) => T | Promise<T>, options?: SpanOptions): Promise<T>;
/**
 * Execute a synchronous function within a new span context.
 */
export declare function withSpanSync<T>(name: string, fn: (span: PulseSpan) => T, options?: SpanOptions): T;
/**
 * Get the currently active span (if any).
 */
export declare function getActiveSpan(): PulseSpan | null;
/**
 * Execute a function within a specific OTel context.
 */
export declare function withContext<T>(ctx: Context, fn: () => T): T;
/**
 * Gracefully shut down the tracer — flushes pending spans.
 * Called during SDK shutdown.
 */
export declare function shutdownTracer(): Promise<void>;
/**
 * Force-flush pending spans without shutting down.
 */
export declare function flushTracer(): Promise<void>;
//# sourceMappingURL=tracer.d.ts.map