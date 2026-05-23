/**
 * Pulse SDK Tracer — enterprise-grade distributed tracing built on OpenTelemetry.
 *
 * Architecture (v3.0):
 *   PulseTracer → OTel NodeTracerProvider → PipelineSpanExporter → SDK EventPipeline
 *
 * Design principles:
 *   - OTel owns: span lifecycle, context propagation, sampling, instrumentation
 *   - SDK owns: span export → event pipeline, transport, batching, enrichment
 *   - PulseSpan is a THIN wrapper — zero duplicated state
 *   - All enrichment (tenant, session, SDK metadata) happens in the exporter,
 *     not in PulseSpan or at span creation time
 *   - Centralized SDK name/version constants (no hardcoded strings)
 */
import { type Tracer, type Context } from '@opentelemetry/api';
import { PulseSpan, type SpanOptions } from './span.js';
import type { ResolvedSDKConfig } from '../types/config.js';
import type { ResourceAttributes } from '../utils/resource-detector.js';
/**
 * Initialize the OpenTelemetry tracer provider.
 * Called during SDK init when `enableTracing: true`.
 *
 * Idempotent — safe to call multiple times.
 */
export declare function initTracer(config: ResolvedSDKConfig, customResources?: ResourceAttributes): void;
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
 * Get the internal tracer instance for advanced SDK use.
 * Returns null if tracing is not initialized.
 * @internal
 */
export declare function getTracer(): Tracer | null;
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