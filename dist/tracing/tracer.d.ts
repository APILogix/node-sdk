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
import type { RemoteConfigResponse } from '../types/config.js';
import type { ResourceAttributes } from '../utils/resource-detector.js';
/**
 * Initialize the OpenTelemetry tracer provider.
 * Called during SDK init when `enableTracing: true`.
 *
 * Idempotent — safe to call multiple times.
 */
export declare function initTracer(config: Readonly<RemoteConfigResponse>, customResources?: ResourceAttributes): void;
/**
 * Start a new span and return a `PulseSpan` wrapper.
 *
 * ⚠️  IMPORTANT — context semantics:
 *
 * This function does NOT install the new span as the *active* span in the
 * AsyncLocalStorage context. Code that runs after `startSpan(...)` returns
 * still sees the previous active span (or no active span). That means:
 *
 *   1. Any OTel auto-instrumentation that runs after this call (Prisma,
 *      Redis, MongoDB, the next outbound HTTP request, etc.) will create
 *      its span as a child of the *previous* active span, NOT this one.
 *
 *   2. `withSpan(...)` calls inside the same scope will be siblings of
 *      this span, not children.
 *
 * This is the standard OTel `tracer.startSpan` semantics — for a span
 * that needs to act as the active parent across an async boundary, use
 * `withSpan(name, fn)` (callback form) or `startActiveSpan(name, fn)`.
 *
 * Use `startSpan` for short, manually-managed spans where the caller
 * explicitly attaches children (or accepts that there are no children).
 * The caller MUST call `span.end()` exactly once. There is no auto-close.
 *
 * @param name - Span name (e.g. 'HTTP GET /api/users', 'db.query', 'cache.get')
 * @param options - Optional span configuration
 * @returns PulseSpan instance (or a no-op span if tracing is not initialized)
 */
export declare function startSpan(name: string, options?: SpanOptions): PulseSpan;
/**
 * Execute an async function within a new span context.
 *
 * The span is installed as the *active* span in the OTel context for the
 * lifetime of the callback (and all async work it spawns), then ended
 * automatically when the callback resolves, rejects, or hits its timeout.
 *
 * This is the canonical way to create user spans — child spans created by
 * any code inside `fn` (whether by `withSpan`, by `startSpan`, or by OTel
 * auto-instrumentation like `HttpInstrumentation` / `PrismaInstrumentation`)
 * will be linked as children of this span via `AsyncLocalStorage`
 * propagation.
 *
 * Lifecycle guarantees:
 *   - The span is always ended exactly once (the `_ended` guard makes
 *     `pulseSpan.end()` idempotent — both the timeout timer and the finally
 *     block call it; only the first one wins).
 *   - The span ends with status `ok` if the callback resolves cleanly,
 *     `error` if it throws (the original exception is recorded as a span
 *     event and re-thrown unmodified).
 *   - If `options.timeoutMs` is set, the span force-ends with status
 *     `error` after the deadline. The user's promise is NOT cancelled —
 *     the SDK never aborts user work. A `pulse.span.timeout` event is
 *     attached so the trace UI can show the deadline overrun.
 *   - CPU profiling is started on the *root* span only and stopped in the
 *     same `finally` block. Profiling failures are logged and never block
 *     span lifecycle.
 *
 * Parent attribution:
 *   The active span at *call time* (snapshotted before we open the new
 *   active scope) is recorded as the parent of this span. This is what
 *   `pulseSpan.parentSpanId` returns and what flows into the exported
 *   span event via OTel's own `parentSpanContext`.
 */
export declare function withSpan<T>(name: string, fnOrOptions: ((span: PulseSpan) => T | Promise<T>) | SpanOptions, optionsOrFn?: SpanOptions | ((span: PulseSpan) => T | Promise<T>)): Promise<T>;
/**
 * Synchronous version of `withSpan`. Same contract, except `fn` may not
 * return a Promise. The span is ended synchronously when `fn` returns or
 * throws. Use this only when you genuinely need synchronous span ownership;
 * `withSpan` is preferred everywhere else.
 */
export declare function withSpanSync<T>(name: string, fnOrOptions: ((span: PulseSpan) => T) | SpanOptions, optionsOrFn?: SpanOptions | ((span: PulseSpan) => T)): T;
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
 *
 * Prefer `withContext` from `core/context` for user-facing code — that
 * helper additionally propagates the SDK's per-request `ContextStore`
 * (breadcrumbs, requestId, tenantId). This function is the raw OTel
 * primitive for advanced consumers (worker pools, custom propagation).
 *
 * @internal
 */
export declare function withOtelContext<T>(ctx: Context, fn: () => T): T;
/**
 * Gracefully shut down the tracer — flushes pending spans and releases the
 * provider/context manager so the next initTracer() can register cleanly.
 *
 * Idempotent: safe to call multiple times. Safe to call before initTracer
 * (no-op).
 */
export declare function shutdownTracer(): Promise<void>;
/**
 * Force-flush pending spans without shutting down.
 */
export declare function flushTracer(): Promise<void>;
//# sourceMappingURL=tracer.d.ts.map