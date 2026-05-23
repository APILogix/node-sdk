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

import {
    trace,
    type Tracer,
    type Span,
    type SpanOptions as OTelSpanOptions,
    SpanKind,
    type Attributes,
    type Context,
    context as otelContext,
} from '@opentelemetry/api'
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node'
import {
    BatchSpanProcessor,
    ParentBasedSampler,
    TraceIdRatioBasedSampler,
    type SpanExporter,
    type ReadableSpan,
} from '@opentelemetry/sdk-trace-base'
import { resourceFromAttributes } from '@opentelemetry/resources'
import {
    ATTR_SERVICE_NAME,
    ATTR_SERVICE_VERSION,
    ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
} from '@opentelemetry/semantic-conventions'
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import { PulseSpan, type SpanOptions } from './span.js'
import { getLogger } from '../utils/logger.js'
import type { ResolvedSDKConfig } from '../types/config.js'
import { processEvent } from '../core/event-pipeline.js'
import { getRequestContext } from '../core/context.js'
import { costGovernor } from '../utils/cost-governor.js'
import type { ResourceAttributes } from '../utils/resource-detector.js'
import { RemoteConfigSampler } from './remote-config-sampler.js'
import { ConfigManager } from '../core/config-manager.js'
import os from 'node:os'

import { SDK_NAME, SDK_VERSION } from '../constants/version.js'

// ─── State ──────────────────────────────────────────────────────────────────

let provider: NodeTracerProvider | null = null
let tracer: Tracer | null = null
let noopTracer: Tracer | null = null
let initialized = false
let ownsProvider = false
let sdkConfig: ResolvedSDKConfig | null = null
const TRACER_PROVIDER_SYMBOL = Symbol.for('pulse-sdk.otel.tracer-provider')

// ─── Span Exporter → SDK Event Pipeline ─────────────────────────────────────

/**
 * Custom SpanExporter that routes finished spans through the SDK's
 * event processing pipeline.
 *
 * This is where ALL Pulse-specific enrichment happens:
 * - SDK metadata (name, version, service, environment)
 * - Tenant/session correlation from request context
 * - Cost governance (span-per-trace limits)
 * - Span → event transformation
 *
 * The OTel ReadableSpan is the SINGLE SOURCE OF TRUTH.
 */
class PipelineSpanExporter implements SpanExporter {

    export(spans: ReadableSpan[], resultCallback: (result: { code: number; error?: Error }) => void): void {
        try {
            for (const span of spans) {
                // Cost governance: check span-per-trace limits
                const traceId = span.spanContext().traceId
                if (!costGovernor.canCreateSpan(traceId)) {
                    continue // Drop span — trace exceeded budget
                }

                const traceEvent = this.spanToEvent(span)
                processEvent(traceEvent)
            }
            resultCallback({ code: 0 }) // SUCCESS
        } catch (err) {
            getLogger().error('Span export failed', { error: err, spanCount: spans.length })
            resultCallback({ code: 1, error: err instanceof Error ? err : new Error(String(err)) })
        }
    }

    shutdown(): Promise<void> {
        return Promise.resolve()
    }

    forceFlush(): Promise<void> {
        return Promise.resolve()
    }

    /**
     * Transform an OTel ReadableSpan into a Pulse SDK event.
     *
     * The ReadableSpan is the single source of truth — we read:
     * - spanContext() → traceId, spanId, traceFlags
     * - parentSpanId → from ReadableSpan directly (NOT from PulseSpan)
     * - name, attributes, status, events, links, duration
     * - resource → service metadata
     *
     * We ENRICH with:
     * - SDK metadata (centralized constants)
     * - Tenant/session from current request context
     * - Service/environment from resolved SDK config
     *
     * tracing.capture.* security gates:
     * - headers: false → strip http.request.header.* and http.response.header.*
     * - body: false → strip http.request.body and http.response.body
     * - query: false → strip http.url query params
     * - cookies: false → strip http.request.header.cookie
     */
    private spanToEvent(span: ReadableSpan): Record<string, unknown> {
        const ctx = span.spanContext()
        const attrs = span.attributes
        const status = span.status
        const durationMs = hrTimeToMs(span.duration)

        // parentSpanId is available at runtime on ReadableSpan but not typed on the interface
        const parentSpanId = (span as unknown as Record<string, unknown>).parentSpanId as string | undefined

        const statusLabel = status.code === 0 ? 'unset' : status.code === 1 ? 'ok' : 'error'

        // Read current request context for tenant/session enrichment
        const requestCtx = getRequestContext()

        // Apply tracing.capture.* security gates from remote config
        let filteredAttrs = Object.fromEntries(
            Object.entries(attrs).filter(([, v]) => v !== undefined)
        )

        try {
            const tracingConfig = ConfigManager.getInstance().getConfig().tracing
            const capture = tracingConfig.capture

            if (!capture.headers) {
                filteredAttrs = Object.fromEntries(
                    Object.entries(filteredAttrs).filter(([k]) =>
                        !k.startsWith('http.request.header.') && !k.startsWith('http.response.header.')
                    )
                )
            }
            if (!capture.body) {
                delete filteredAttrs['http.request.body']
                delete filteredAttrs['http.response.body']
            }
            if (!capture.cookies) {
                delete filteredAttrs['http.request.header.cookie']
                delete filteredAttrs['http.request.header.set-cookie']
            }
            if (!capture.response) {
                filteredAttrs = Object.fromEntries(
                    Object.entries(filteredAttrs).filter(([k]) =>
                        !k.startsWith('http.response.')
                    )
                )
            }

            // Enforce maxSpanAttributes from remote config
            const maxAttrs = tracingConfig.maxSpanAttributes
            const attrEntries = Object.entries(filteredAttrs)
            if (attrEntries.length > maxAttrs) {
                filteredAttrs = Object.fromEntries(attrEntries.slice(0, maxAttrs))
                filteredAttrs['pulse.attributes_truncated'] = true
                filteredAttrs['pulse.original_attribute_count'] = attrEntries.length
            }
        } catch {
            // ConfigManager not initialized — use unfiltered attributes
        }

        return {
            type: 'span',
            eventId: `span_${ctx.spanId}`,
            spanId: ctx.spanId,
            traceId: ctx.traceId,
            parentSpanId,
            name: span.name,
            startTime: hrTimeToMs(span.startTime),
            endTime: hrTimeToMs(span.endTime),
            duration: durationMs,
            status: statusLabel,
            statusMessage: status.message,
            attributes: filteredAttrs,
            events: span.events.map(e => ({
                name: e.name,
                timestamp: hrTimeToMs(e.time),
                attributes: e.attributes,
            })),
            links: span.links.map(l => ({
                traceId: l.context.traceId,
                spanId: l.context.spanId,
                attributes: l.attributes,
            })),
            // Pulse-specific enrichment — done HERE, not in PulseSpan
            metadata: {
                sdkName: SDK_NAME,
                sdkVersion: SDK_VERSION,
                service: sdkConfig?.service ?? '',
                environment: sdkConfig?.environment ?? '',
            },
            // Tenant/session correlation from request context
            requestId: requestCtx?.requestId,
            sessionId: requestCtx?.sessionId,
            userId: requestCtx?.userId,
            tenantId: (requestCtx?.extra as Record<string, unknown> | undefined)?.['tenantId'] as string | undefined,
        }
    }
}

// ─── Initialization ─────────────────────────────────────────────────────────

/**
 * Initialize the OpenTelemetry tracer provider.
 * Called during SDK init when `enableTracing: true`.
 *
 * Idempotent — safe to call multiple times.
 */
export function initTracer(config: ResolvedSDKConfig, customResources?: ResourceAttributes): void {
    if (initialized) return

    const logger = getLogger()
    sdkConfig = config

    try {
        const globalState = globalThis as typeof globalThis & { [TRACER_PROVIDER_SYMBOL]?: true }
        if (globalState[TRACER_PROVIDER_SYMBOL]) {
            tracer = trace.getTracer(SDK_NAME, SDK_VERSION)
            initialized = true
            ownsProvider = false
            logger.info('OpenTelemetry tracer provider already registered by Pulse SDK; reusing global provider')
            return
        }

        const existingGlobal = getOtelGlobalApi()
        if (existingGlobal?.trace || existingGlobal?.context) {
            tracer = trace.getTracer(SDK_NAME, SDK_VERSION)
            initialized = true
            ownsProvider = false
            logger.info('Existing OpenTelemetry provider/context manager detected; Pulse SDK will not register another provider')
            return
        }

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
            'telemetry.sdk.name': SDK_NAME,
            'telemetry.sdk.version': SDK_VERSION,
            'telemetry.sdk.language': 'nodejs',
            ...(customResources ?? {}),
        })

        // Create provider with resource
        // Use RemoteConfigSampler for deterministic FNV-1a sampling with route overrides
        const remoteConfigSampler = new RemoteConfigSampler()
        provider = new NodeTracerProvider({
            resource,
            sampler: new ParentBasedSampler({
                root: remoteConfigSampler as any, // RemoteConfigSampler implements shouldSample
            }),
            spanProcessors: [
                new BatchSpanProcessor(new PipelineSpanExporter(), {
                    maxQueueSize: 2048,
                    maxExportBatchSize: 512,
                    scheduledDelayMillis: 5000,
                    exportTimeoutMillis: 30000,
                }),
            ],
        })

        // Register context manager for async propagation
        const contextManager = new AsyncLocalStorageContextManager()
        contextManager.enable()
        provider.register({ contextManager })
        globalState[TRACER_PROVIDER_SYMBOL] = true
        ownsProvider = true

        // Get the tracer instance
        tracer = trace.getTracer(SDK_NAME, SDK_VERSION)

        initialized = true

        logger.info('OpenTelemetry tracer initialized', {
            service: config.service,
            environment: config.environment,
            release: config.release,
        })
    } catch (err) {
        logger.error('Failed to initialize OpenTelemetry tracer', { error: err })
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
export function startSpan(name: string, options?: SpanOptions): PulseSpan {
    const logger = getLogger()

    if (!tracer) {
        logger.debug('startSpan called but tracer is not initialized — returning no-op span', { name })
        if (!noopTracer) {
            noopTracer = trace.getTracer(SDK_NAME + '/noop')
        }
        const noopSpan = noopTracer.startSpan(name)
        return new PulseSpan(noopSpan)
    }

    try {
        const otelOptions: OTelSpanOptions = {}
        if (options?.attributes) otelOptions.attributes = options.attributes
        if (options?.startTime) otelOptions.startTime = options.startTime
        if (options?.links) {
            otelOptions.links = PulseSpan.toOTelLinks(options.links)
        }

        const span = tracer.startSpan(name, otelOptions)
        return new PulseSpan(span)
    } catch (err) {
        logger.warn('Failed to start span', { name, error: err })
        if (!noopTracer) {
            noopTracer = trace.getTracer(SDK_NAME + '/noop')
        }
        const noopSpan = noopTracer.startSpan(name)
        return new PulseSpan(noopSpan)
    }
}

/**
 * Execute a function within a new span context.
 * The span is automatically ended when the function completes (or throws).
 */
export async function withSpan<T>(
    name: string,
    fn: (span: PulseSpan) => T | Promise<T>,
    options?: SpanOptions
): Promise<T> {
    if (!tracer) {
        const span = startSpan(name, options)
        try {
            const result = await fn(span)
            span.setStatus('ok')
            return result
        } catch (err) {
            if (err instanceof Error) {
                span.recordError(err)
            }
            span.setStatus('error', err instanceof Error ? err.message : String(err))
            throw err
        } finally {
            span.end()
        }
    }

    const otelOptions = toOtelSpanOptions(options)
    return tracer.startActiveSpan(name, otelOptions, async span => {
        const pulseSpan = new PulseSpan(span)
        try {
            const result = await fn(pulseSpan)
            pulseSpan.setStatus('ok')
            return result
        } catch (err) {
            if (err instanceof Error) {
                pulseSpan.recordError(err)
            }
            pulseSpan.setStatus('error', err instanceof Error ? err.message : String(err))
            throw err
        } finally {
            pulseSpan.end()
        }
    })
}

/**
 * Execute a synchronous function within a new span context.
 */
export function withSpanSync<T>(
    name: string,
    fn: (span: PulseSpan) => T,
    options?: SpanOptions
): T {
    if (!tracer) {
        const span = startSpan(name, options)
        try {
            const result = fn(span)
            span.setStatus('ok')
            return result
        } catch (err) {
            if (err instanceof Error) {
                span.recordError(err)
            }
            span.setStatus('error', err instanceof Error ? err.message : String(err))
            throw err
        } finally {
            span.end()
        }
    }

    const otelOptions = toOtelSpanOptions(options)
    return tracer.startActiveSpan(name, otelOptions, span => {
        const pulseSpan = new PulseSpan(span)
        try {
            const result = fn(pulseSpan)
            pulseSpan.setStatus('ok')
            return result
        } catch (err) {
            if (err instanceof Error) {
                pulseSpan.recordError(err)
            }
            pulseSpan.setStatus('error', err instanceof Error ? err.message : String(err))
            throw err
        } finally {
            pulseSpan.end()
        }
    })
}

// ─── Active Span ────────────────────────────────────────────────────────────

/**
 * Get the currently active span (if any).
 */
export function getActiveSpan(): PulseSpan | null {
    const span = trace.getActiveSpan()
    if (!span) return null
    return new PulseSpan(span)
}

/**
 * Get the internal tracer instance for advanced SDK use.
 * Returns null if tracing is not initialized.
 * @internal
 */
export function getTracer(): Tracer | null {
    return tracer
}

/**
 * Execute a function within a specific OTel context.
 */
export function withContext<T>(ctx: Context, fn: () => T): T {
    return otelContext.with(ctx, fn)
}

// ─── Shutdown ───────────────────────────────────────────────────────────────

/**
 * Gracefully shut down the tracer — flushes pending spans.
 * Called during SDK shutdown.
 */
export async function shutdownTracer(): Promise<void> {
    const logger = getLogger()

    if (!provider) {
        logger.debug('Tracer shutdown skipped — not initialized')
        return
    }

    try {
        await provider.forceFlush()
        if (ownsProvider) {
            await provider.shutdown()
            delete (globalThis as typeof globalThis & { [TRACER_PROVIDER_SYMBOL]?: true })[TRACER_PROVIDER_SYMBOL]
        }
        initialized = false
        provider = null
        tracer = null
        sdkConfig = null
        ownsProvider = false
        logger.info('OpenTelemetry tracer shut down')
    } catch (err) {
        logger.error('Failed to shut down OpenTelemetry tracer', { error: err })
    }
}

/**
 * Force-flush pending spans without shutting down.
 */
export async function flushTracer(): Promise<void> {
    if (!provider) return
    try {
        await provider.forceFlush()
    } catch (err) {
        getLogger().error('Failed to flush tracer', { error: err })
    }
}

// ─── Utilities ──────────────────────────────────────────────────────────────

function hrTimeToMs(hrTime: [number, number]): number {
    return hrTime[0] * 1000 + hrTime[1] / 1e6
}

function toOtelSpanOptions(options?: SpanOptions): OTelSpanOptions {
    const otelOptions: OTelSpanOptions = {}
    if (options?.attributes) otelOptions.attributes = options.attributes
    if (options?.startTime) otelOptions.startTime = options.startTime
    if (options?.links) otelOptions.links = PulseSpan.toOTelLinks(options.links)
    return otelOptions
}

function getOtelGlobalApi(): { trace?: unknown; context?: unknown } | undefined {
    const key = Symbol.for('opentelemetry.js.api.1')
    return (globalThis as typeof globalThis & { [key]?: { trace?: unknown; context?: unknown } })[key]
}
