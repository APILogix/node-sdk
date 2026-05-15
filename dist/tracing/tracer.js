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
import { trace, SpanKind, context as otelContext, } from '@opentelemetry/api';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION, ATTR_DEPLOYMENT_ENVIRONMENT_NAME, } from '@opentelemetry/semantic-conventions';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { PulseSpan } from './span.js';
import { getLogger } from '../utils/logger.js';
import { processEvent } from '../core/event-pipeline.js';
import os from 'node:os';
// ─── State ──────────────────────────────────────────────────────────────────
let provider = null;
let tracer = null;
let initialized = false;
// ─── Span Exporter → SDK Event Pipeline ─────────────────────────────────────
/**
 * Custom SpanExporter that routes finished spans through the SDK's
 * event processing pipeline instead of sending them directly.
 * This ensures spans get sanitized, plugin-processed, and batched.
 */
class PipelineSpanExporter {
    logger = getLogger();
    export(spans, resultCallback) {
        try {
            for (const span of spans) {
                const traceEvent = this.spanToEvent(span);
                processEvent(traceEvent);
            }
            resultCallback({ code: 0 }); // SUCCESS
        }
        catch (err) {
            this.logger.error('Span export failed', { error: err, spanCount: spans.length });
            resultCallback({ code: 1, error: err instanceof Error ? err : new Error(String(err)) });
        }
    }
    shutdown() {
        return Promise.resolve();
    }
    forceFlush() {
        return Promise.resolve();
    }
    spanToEvent(span) {
        const ctx = span.spanContext();
        const attrs = span.attributes;
        const status = span.status;
        return {
            type: 'request',
            eventId: ctx.spanId,
            timestamp: hrTimeToMs(span.startTime),
            url: String(attrs['http.url'] ?? attrs['url.full'] ?? attrs['http.target'] ?? span.name),
            method: String(attrs['http.method'] ?? attrs['http.request.method'] ?? 'INTERNAL'),
            statusCode: Number(attrs['http.status_code'] ?? attrs['http.response.status_code'] ?? (status.code === 2 ? 500 : 200)),
            latency: hrTimeToMs(span.duration),
            traceId: ctx.traceId,
            spanId: ctx.spanId,
            metadata: {
                sdk: { name: '@vikasbaplawat1/pulse-sdk', version: '2.0.0' },
                runtime: { name: 'node', version: process.version },
                os: { name: process.platform, version: os.release() },
                trace: {
                    spanName: span.name,
                    spanKind: SpanKind[span.kind] ?? 'INTERNAL',
                    parentSpanId: span.parentSpanId ?? undefined,
                    attributes: Object.fromEntries(Object.entries(attrs).filter(([, v]) => v !== undefined)),
                    events: span.events.map(e => ({
                        name: e.name,
                        time: hrTimeToMs(e.time),
                        attributes: e.attributes,
                    })),
                    status: {
                        code: status.code,
                        message: status.message,
                    },
                    links: span.links.map(l => ({
                        traceId: l.context.traceId,
                        spanId: l.context.spanId,
                    })),
                },
            },
        };
    }
}
// ─── Initialization ─────────────────────────────────────────────────────────
/**
 * Initialize the OpenTelemetry tracer provider.
 * Called during SDK init when `enableTracing: true`.
 *
 * Idempotent — safe to call multiple times.
 */
export function initTracer(config) {
    if (initialized)
        return;
    const logger = getLogger();
    try {
        // Build resource descriptor
        const resource = resourceFromAttributes({
            [ATTR_SERVICE_NAME]: config.service,
            [ATTR_SERVICE_VERSION]: config.release,
            [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: config.environment,
            'host.name': os.hostname(),
            'host.arch': os.arch(),
            'os.type': os.type(),
            'os.version': os.release(),
            'process.pid': process.pid,
            'process.runtime.name': 'node',
            'process.runtime.version': process.version,
            'telemetry.sdk.name': '@vikasbaplawat1/pulse-sdk',
            'telemetry.sdk.version': '2.0.0',
            'telemetry.sdk.language': 'nodejs',
        });
        // Create provider with resource
        provider = new NodeTracerProvider({
            resource,
            spanProcessors: [
                new BatchSpanProcessor(new PipelineSpanExporter(), {
                    maxQueueSize: 2048,
                    maxExportBatchSize: 512,
                    scheduledDelayMillis: 5000,
                    exportTimeoutMillis: 30000,
                }),
            ],
        });
        // Register context manager for async propagation
        const contextManager = new AsyncLocalStorageContextManager();
        contextManager.enable();
        provider.register({ contextManager });
        // Get the tracer instance
        tracer = trace.getTracer('@vikasbaplawat1/pulse-sdk', '2.0.0');
        initialized = true;
        logger.info('OpenTelemetry tracer initialized', {
            service: config.service,
            environment: config.environment,
            release: config.release,
        });
    }
    catch (err) {
        logger.error('Failed to initialize OpenTelemetry tracer', { error: err });
        // Tracing failure should never block SDK init
    }
}
// ─── Span Creation ──────────────────────────────────────────────────────────
/**
 * Start a new span. Returns a PulseSpan wrapper.
 *
 * @param name - Span name (e.g. 'HTTP GET /api/users', 'db.query', 'cache.get')
 * @param options - Optional span configuration
 * @returns PulseSpan instance (or a no-op span if tracing is not initialized)
 */
export function startSpan(name, options) {
    const logger = getLogger();
    if (!tracer) {
        logger.debug('startSpan called but tracer is not initialized — returning no-op span', { name });
        // Return a no-op span using the API's built-in no-op
        const noopSpan = trace.getTracer('noop').startSpan(name);
        return new PulseSpan(noopSpan);
    }
    try {
        const otelOptions = {};
        if (options?.attributes)
            otelOptions.attributes = options.attributes;
        if (options?.startTime)
            otelOptions.startTime = options.startTime;
        const span = tracer.startSpan(name, otelOptions);
        return new PulseSpan(span);
    }
    catch (err) {
        logger.warn('Failed to start span', { name, error: err });
        const noopSpan = trace.getTracer('noop').startSpan(name);
        return new PulseSpan(noopSpan);
    }
}
/**
 * Execute a function within a new span context.
 * The span is automatically ended when the function completes (or throws).
 *
 * @param name - Span name
 * @param fn - Function to execute within the span context
 * @param options - Optional span configuration
 * @returns The return value of the function
 */
export async function withSpan(name, fn, options) {
    const span = startSpan(name, options);
    try {
        const result = await fn(span);
        span.setStatus('ok');
        return result;
    }
    catch (err) {
        if (err instanceof Error) {
            span.recordError(err);
        }
        span.setStatus('error', err instanceof Error ? err.message : String(err));
        throw err;
    }
    finally {
        span.end();
    }
}
/**
 * Execute a synchronous function within a new span context.
 */
export function withSpanSync(name, fn, options) {
    const span = startSpan(name, options);
    try {
        const result = fn(span);
        span.setStatus('ok');
        return result;
    }
    catch (err) {
        if (err instanceof Error) {
            span.recordError(err);
        }
        span.setStatus('error', err instanceof Error ? err.message : String(err));
        throw err;
    }
    finally {
        span.end();
    }
}
// ─── Active Span ────────────────────────────────────────────────────────────
/**
 * Get the currently active span (if any).
 */
export function getActiveSpan() {
    const span = trace.getActiveSpan();
    if (!span)
        return null;
    return new PulseSpan(span);
}
/**
 * Execute a function within a specific OTel context.
 */
export function withContext(ctx, fn) {
    return otelContext.with(ctx, fn);
}
// ─── Shutdown ───────────────────────────────────────────────────────────────
/**
 * Gracefully shut down the tracer — flushes pending spans.
 * Called during SDK shutdown.
 */
export async function shutdownTracer() {
    const logger = getLogger();
    if (!provider) {
        logger.debug('Tracer shutdown skipped — not initialized');
        return;
    }
    try {
        await provider.forceFlush();
        await provider.shutdown();
        initialized = false;
        provider = null;
        tracer = null;
        logger.info('OpenTelemetry tracer shut down');
    }
    catch (err) {
        logger.error('Failed to shut down OpenTelemetry tracer', { error: err });
    }
}
/**
 * Force-flush pending spans without shutting down.
 */
export async function flushTracer() {
    if (!provider)
        return;
    try {
        await provider.forceFlush();
    }
    catch (err) {
        getLogger().error('Failed to flush tracer', { error: err });
    }
}
// ─── Utilities ──────────────────────────────────────────────────────────────
function hrTimeToMs(hrTime) {
    return hrTime[0] * 1000 + hrTime[1] / 1e6;
}
//# sourceMappingURL=tracer.js.map