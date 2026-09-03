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
import {
    computeExclusiveDuration,
    spanDurationTracker,
} from './span-duration.js'
import { getTraceAggregator, resetTraceAggregator } from './trace-aggregator.js'
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node'
import {
    BatchSpanProcessor,
    ParentBasedSampler,
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
import {
    W3CTraceContextPropagator,
    CompositePropagator,
    W3CBaggagePropagator,
    suppressTracing,
} from '@opentelemetry/core'
import { TRACING_DEFAULTS } from '../constants/internal-defaults.js'
import { PulseSpan, type SpanOptions } from './span.js'
import { getLogger } from '../utils/logger.js'
import type { RemoteConfigResponse } from '../types/config.js'
import { processEvent } from '../core/event-pipeline.js'
import {
    getRequestContext,
    PULSE_CONTEXT_ATTRIBUTES,
} from '../core/context.js'
import { costGovernor } from '../utils/cost-governor.js'
import type { ResourceAttributes } from '../utils/resource-detector.js'
import { RemoteConfigSampler } from './remote-config-sampler.js'
import { ConfigManager } from '../core/config-manager.js'
import { ProfilingSubsystem } from '../subsystems/profiling-subsystem.js'
import { EntitlementGate } from '../core/entitlement-gate.js'
import os from 'node:os'

import { SDK_NAME, SDK_VERSION } from '../constants/version.js'

// ─── State ──────────────────────────────────────────────────────────────────

let provider: NodeTracerProvider | null = null
let tracer: Tracer | null = null
let noopTracer: Tracer | null = null
let initialized = false
let ownsProvider = false
const TRACER_PROVIDER_SYMBOL = Symbol.for('pulse-sdk.otel.tracer-provider')
const PULSE_INTERNAL_CONTEXT_KEY = Symbol.for('pulse-sdk.internal-context')

/**
 * Build a non-recording PulseSpan. Used when the tracer is not initialized,
 * when span creation fails, and when the `customSpans` entitlement is
 * revoked — in every case the caller gets a span object it can safely call
 * `end()` / `setAttribute()` on, but nothing is recorded or exported.
 */
function createNoopSpan(name: string): PulseSpan {
    if (!noopTracer) {
        noopTracer = trace.getTracer(SDK_NAME + '/noop')
    }
    return new PulseSpan(noopTracer.startSpan(name))
}

/**
 * Custom developer spans are gated by the `customSpans` entitlement.
 * Revoked ⇒ every custom span API returns a non-recording noop span.
 * Automatic instrumentation is unaffected (it uses the OTel tracer
 * directly, not these developer-facing wrappers).
 */
function customSpansAllowed(): boolean {
    return EntitlementGate.isAllowed('customSpans')
}

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
        const activeCtx = otelContext.active()
        if (activeCtx.getValue(PULSE_INTERNAL_CONTEXT_KEY)) {
            getLogger().warn('Exporter recursion detected: dropping spans to prevent telemetry loop', {
                droppedSpans: spans.length,
                event: 'EXPORTER_RECURSION_PREVENTED'
            })
            resultCallback({ code: 0 })
            return
        }

        const safeCtx = suppressTracing(activeCtx.setValue(PULSE_INTERNAL_CONTEXT_KEY, true))

        otelContext.with(safeCtx, () => {
            try {
                let allAccepted = true
                const traceIdsInBatch = new Set<string>()
                const rootTraceIds = new Set<string>()
                const admittedSpans = new Set<ReadableSpan>()

                // Pass 1: Record all child intervals for the batch first
                for (const span of spans) {
                    const ctx = span.spanContext()
                    const traceId = ctx.traceId

                    const isSampled = (ctx.traceFlags & 1) === 1
                    const hasError = span.status.code === 2
                        || span.events.some(e => e.name === 'exception')
                    if (!isSampled && !hasError) {
                        continue
                    }

                    if (!costGovernor.canCreateSpan(traceId) || !costGovernor.canContinueTrace(traceId)) {
                        continue
                    }
                    admittedSpans.add(span)

                    const parentSpanId = span.parentSpanContext?.spanId
                    if (parentSpanId) {
                        spanDurationTracker.recordChildInterval(
                            traceId,
                            parentSpanId,
                            hrTimeToMs(span.startTime),
                            hrTimeToMs(span.endTime),
                        )
                    }
                }

                // Pass 2: Process spans, convert to events, and send to aggregator
                for (const span of spans) {
                    if (!admittedSpans.has(span)) continue

                    const ctx = span.spanContext()
                    const traceId = ctx.traceId
                    traceIdsInBatch.add(traceId)

                    const traceEvent = this.spanToEvent(span)
                    if (!processEvent(traceEvent)) {
                        allAccepted = false
                    }

                    try {
                        getTraceAggregator().addSpan(traceEvent)
                    } catch {}

                    const parentSpanId = span.parentSpanContext?.spanId
                    if (!parentSpanId) {
                        rootTraceIds.add(traceId)
                    }
                }

                // Flush completed traces at the end of the batch export to prevent race conditions
                for (const traceId of traceIdsInBatch) {
                    try {
                        getTraceAggregator().flushIfComplete(traceId)
                    } catch {}
                }

                // Clean up span duration tracker for traces whose root spans were processed in this batch
                for (const traceId of rootTraceIds) {
                    try {
                        spanDurationTracker.cleanupTrace(traceId)
                    } catch {}
                }

                resultCallback({ code: allAccepted ? 0 : 1 })
            } catch (err) {
                getLogger().error('Span export failed', { error: err, spanCount: spans.length })
                resultCallback({ code: 1, error: err instanceof Error ? err : new Error(String(err)) })
            }
        })
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

        const parentSpanId = span.parentSpanContext?.spanId

        const statusLabel = status.code === 0 ? 'unset' : status.code === 1 ? 'ok' : 'error'

        // Read one immutable snapshot for all policy applied to this span.
        const activeConfig = ConfigManager.getInstance().getConfig()
        const capture = activeConfig.privacy.capture
        let filteredAttrs = Object.fromEntries(
            Object.entries(attrs).filter(([, value]) => value !== undefined)
        )

        if (!capture.headers) {
            filteredAttrs = Object.fromEntries(
                Object.entries(filteredAttrs).filter(([key]) =>
                    !key.startsWith('http.request.header.') && !key.startsWith('http.response.header.')
                )
            )
        }
        if (!capture.body) {
            delete filteredAttrs['http.request.body']
            delete filteredAttrs['http.response.body']
        }
        if (!capture.query) {
            for (const key of ['http.url', 'http.target', 'url.full']) {
                const value = filteredAttrs[key]
                if (typeof value === 'string') filteredAttrs[key] = value.split('?')[0] ?? value
            }
        }
        if (!capture.cookies) {
            delete filteredAttrs['http.request.header.cookie']
            delete filteredAttrs['http.request.header.set-cookie']
        }
        if (!capture.response) {
            delete filteredAttrs['http.response.body']
        }

        const maxAttrs = activeConfig.limits.maxSpanAttributes
        const attrEntries = Object.entries(filteredAttrs)
        if (attrEntries.length > maxAttrs) {
            const retained = Math.max(0, maxAttrs - Math.min(2, maxAttrs))
            filteredAttrs = Object.fromEntries(attrEntries.slice(0, retained))
            if (maxAttrs >= 1) filteredAttrs['pulse.attributes_truncated'] = true
            if (maxAttrs >= 2) filteredAttrs['pulse.original_attribute_count'] = attrEntries.length
        }

        const startTimeMs = hrTimeToMs(span.startTime)
        const endTimeMs = hrTimeToMs(span.endTime)

        // Compute exclusive (self) duration by subtracting merged child
        // span intervals from this span's total duration. This enables
        // performance attribution: "DB took 50ms, business logic 400ms".
        const childIntervals = spanDurationTracker.getChildIntervals(ctx.traceId, ctx.spanId)
        const durationBreakdown = computeExclusiveDuration(startTimeMs, endTimeMs, childIntervals)

        return {
            type: 'span',
            eventId: `span_${ctx.spanId}`,
            spanId: ctx.spanId,
            traceId: ctx.traceId,
            parentSpanId,
            name: span.name,
            kind: spanKindToString(span.kind),
            startTime: startTimeMs,
            endTime: endTimeMs,
            duration: durationMs,
            exclusiveDuration: durationBreakdown.exclusiveDuration,
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
            // Pulse-specific enrichment. The event pipeline replaces this
            // snapshot with the canonical immutable client metadata before send.
            metadata: {
                sdkName: SDK_NAME,
                sdkVersion: SDK_VERSION,
                applicationName: activeConfig.sdk.service ?? activeConfig.sdk.projectId,
                applicationVersion: activeConfig.sdk.release,
                projectId: activeConfig.sdk.projectId,
                environment: activeConfig.sdk.environment,
                release: activeConfig.sdk.release,
            },
            // Internal marker allows shutdown force-flush to route finished spans
            // while rejecting new user-captured events. Stripped by event pipeline.
            __pulseInternal: true,
            requestId: attrString(attrs[PULSE_CONTEXT_ATTRIBUTES.requestId]),
            sessionId: attrString(attrs[PULSE_CONTEXT_ATTRIBUTES.sessionId]),
            userId: attrString(attrs[PULSE_CONTEXT_ATTRIBUTES.userId]),
            tenantId: attrString(attrs[PULSE_CONTEXT_ATTRIBUTES.tenantId]),
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
export function initTracer(config: Readonly<RemoteConfigResponse>, customResources?: ResourceAttributes): void {
    if (initialized) return

    const logger = getLogger()

    try {
        const globalState = globalThis as typeof globalThis & { [TRACER_PROVIDER_SYMBOL]?: true }
        if (globalState[TRACER_PROVIDER_SYMBOL]) {
            tracer = trace.getTracer(SDK_NAME, SDK_VERSION)
            initialized = true
            ownsProvider = false
            logger.info('OpenTelemetry tracer provider already registered by Pulse telemetry; reusing global provider')
            return
        }
        // Build resource descriptor
        const resource = resourceFromAttributes({
            [ATTR_SERVICE_NAME]: config.sdk.service ?? config.sdk.projectId,
            [ATTR_SERVICE_VERSION]: config.sdk.release,
            [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: config.sdk.environment,
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

        // Build composite propagator for W3C TraceContext + optional Baggage.
        // Without this, OTel's HttpInstrumentation and UndiciInstrumentation
        // will NOT inject traceparent headers into outgoing requests, which
        // breaks distributed tracing across service boundaries.
        const propagators: import('@opentelemetry/api').TextMapPropagator[] = [
            new W3CTraceContextPropagator(),
        ]
        if (TRACING_DEFAULTS.propagation.baggage) {
            propagators.push(new W3CBaggagePropagator())
        }
        const propagator = new CompositePropagator({ propagators })

        provider.register({ contextManager, propagator })
        globalState[TRACER_PROVIDER_SYMBOL] = true
        ownsProvider = true

        // Get the tracer instance
        tracer = trace.getTracer(SDK_NAME, SDK_VERSION)

        initialized = true

        // Start the trace aggregator's background sweep timer.
        // This must happen AFTER the tracer is initialized so exported
        // spans can flow through the aggregator.
        getTraceAggregator().start()

        logger.info('OpenTelemetry tracer initialized', {
            service: config.sdk.service ?? config.sdk.projectId,
            environment: config.sdk.environment,
            release: config.sdk.release,
        })
    } catch (err) {
        logger.error('Failed to initialize OpenTelemetry tracer', { error: err })
        // Tracing failure should never block SDK init
    }
}

// ─── Span Creation ──────────────────────────────────────────────────────────

/**
 * Snapshot the spanId of the currently-active span, if any.
 *
 * Used by every span-creating helper to capture the *parent* before opening
 * a new active scope. We can't do this lookup inside `tracer.startActiveSpan`'s
 * callback because by then the new span is already installed as active, and
 * `trace.getActiveSpan()` would return the new span itself.
 */
function snapshotActiveSpanId(): string | undefined {
    try {
        return trace.getActiveSpan()?.spanContext().spanId
    } catch {
        return undefined
    }
}

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
export function startSpan(name: string, options?: SpanOptions): PulseSpan {
    const logger = getLogger()

    if (!customSpansAllowed()) {
        logger.debug('startSpan called but customSpans entitlement is revoked — returning no-op span', { name })
        return createNoopSpan(name)
    }

    if (!tracer) {
        logger.debug('startSpan called but tracer is not initialized — returning no-op span', { name })
        return createNoopSpan(name)
    }

    try {
        const otelOptions: OTelSpanOptions = {}
        otelOptions.attributes = withRequestContextAttributes(options?.attributes)
        if (options?.startTime) otelOptions.startTime = options.startTime
        if (options?.links) {
            otelOptions.links = PulseSpan.toOTelLinks(options.links)
        }

        const parentSpanId = snapshotActiveSpanId()
        const span = tracer.startSpan(name, otelOptions)
        return new PulseSpan(span, parentSpanId)
    } catch (err) {
        logger.warn('Failed to start span', { name, error: err })
        return createNoopSpan(name)
    }
}

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
export async function withSpan<T>(
    name: string,
    fnOrOptions: ((span: PulseSpan) => T | Promise<T>) | SpanOptions,
    optionsOrFn?: SpanOptions | ((span: PulseSpan) => T | Promise<T>)
): Promise<T> {
    const { fn, options } = resolveWithSpanArgs(fnOrOptions, optionsOrFn)
    if (!tracer || !customSpansAllowed()) {
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
    // Snapshot the parent BEFORE entering the new active scope. Inside the
    // callback below `trace.getActiveSpan()` returns the new span itself,
    // so any parent lookup must happen out here.
    const parentSpanId = snapshotActiveSpanId()
    const isRoot = parentSpanId === undefined
    return tracer.startActiveSpan(name, otelOptions, async span => {
        const pulseSpan = new PulseSpan(span, parentSpanId)
        const logger = getLogger()

        if (isRoot) {
            try {
                const subsystem = ProfilingSubsystem.getInstance()
                if (subsystem) void subsystem.startCpuProfile(pulseSpan.traceId, pulseSpan.spanId)
            } catch (err) {
                logger.warn('Failed to start CPU profile for root span', { error: err })
            }
        }

        // Timeout guard: if timeoutMs is set, create a timer that force-ends
        // the span with TIMEOUT status but does NOT reject the user's promise.
        // This is fail-open — the operation continues, only the span is ended.
        let timeoutTimer: NodeJS.Timeout | undefined
        if (options?.timeoutMs && options.timeoutMs > 0) {
            const timeoutMs = options.timeoutMs
            timeoutTimer = setTimeout(() => {
                if (!pulseSpan.isEnded) {
                    pulseSpan.addEvent('pulse.span.timeout', {
                        'pulse.timeout_ms': timeoutMs,
                    })
                    pulseSpan.setStatus('error', `Span timed out after ${timeoutMs}ms`)
                    pulseSpan.end()
                    logger.warn('Span force-ended due to timeout', {
                        name,
                        timeoutMs,
                        traceId: pulseSpan.traceId,
                        spanId: pulseSpan.spanId,
                    })
                }
            }, timeoutMs)
            timeoutTimer.unref() // Don't keep event loop alive
        }

        try {
            const result = await fn(pulseSpan)
            if (!pulseSpan.isEnded) {
                pulseSpan.setStatus('ok')
            }
            return result
        } catch (err) {
            if (!pulseSpan.isEnded) {
                if (err instanceof Error) {
                    pulseSpan.recordError(err)
                }
                pulseSpan.setStatus('error', err instanceof Error ? err.message : String(err))
            }
            throw err
        } finally {
            if (timeoutTimer) clearTimeout(timeoutTimer)
            if (isRoot) {
                try {
                    const subsystem = ProfilingSubsystem.getInstance()
                    if (subsystem) void subsystem.stopCpuProfile(pulseSpan.traceId)
                } catch (err) {
                    logger.warn('Failed to stop CPU profile for root span', { error: err })
                }
            }
            pulseSpan.end() // Idempotent — safe if timeout already ended it
        }
    })
}

/**
 * Synchronous version of `withSpan`. Same contract, except `fn` may not
 * return a Promise. The span is ended synchronously when `fn` returns or
 * throws. Use this only when you genuinely need synchronous span ownership;
 * `withSpan` is preferred everywhere else.
 */
export function withSpanSync<T>(
    name: string,
    fnOrOptions: ((span: PulseSpan) => T) | SpanOptions,
    optionsOrFn?: SpanOptions | ((span: PulseSpan) => T)
): T {
    const { fn, options } = resolveWithSpanSyncArgs(fnOrOptions, optionsOrFn)
    if (!tracer || !customSpansAllowed()) {
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
    const parentSpanId = snapshotActiveSpanId()
    const isRoot = parentSpanId === undefined
    return tracer.startActiveSpan(name, otelOptions, span => {
        const pulseSpan = new PulseSpan(span, parentSpanId)

        if (isRoot) {
            try {
                const subsystem = ProfilingSubsystem.getInstance()
                if (subsystem) void subsystem.startCpuProfile(pulseSpan.traceId, pulseSpan.spanId)
            } catch (err) {
                getLogger().warn('Failed to start CPU profile for root span', { error: err })
            }
        }

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
            if (isRoot) {
                try {
                    const subsystem = ProfilingSubsystem.getInstance()
                    if (subsystem) void subsystem.stopCpuProfile(pulseSpan.traceId)
                } catch (err) {
                    getLogger().warn('Failed to stop CPU profile for root span', { error: err })
                }
            }
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
 *
 * Prefer `withContext` from `core/context` for user-facing code — that
 * helper additionally propagates the SDK's per-request `ContextStore`
 * (breadcrumbs, requestId, tenantId). This function is the raw OTel
 * primitive for advanced consumers (worker pools, custom propagation).
 *
 * @internal
 */
export function withOtelContext<T>(ctx: Context, fn: () => T): T {
    return otelContext.with(ctx, fn)
}

// ─── Shutdown ───────────────────────────────────────────────────────────────

/**
 * Gracefully shut down the tracer — flushes pending spans and releases the
 * provider/context manager so the next initTracer() can register cleanly.
 *
 * Idempotent: safe to call multiple times. Safe to call before initTracer
 * (no-op).
 */
export async function shutdownTracer(): Promise<void> {
    const logger = getLogger()

    // Snapshot the provider into a local so concurrent calls or a reentrant
    // initTracer() during shutdown can't see a half-cleared module.
    const localProvider = provider
    const ownsLocal = ownsProvider

    if (!localProvider) {
        // Even with no provider, ensure derived state is reset so a stale
        // `initialized` flag from a partial init doesn't block reinit.
        initialized = false
        tracer = null
            ownsProvider = false
        // Clear the global guard if we own it — otherwise leave it for
        // whoever registered the provider externally.
        if (ownsLocal) {
            delete (globalThis as typeof globalThis & { [TRACER_PROVIDER_SYMBOL]?: true })[TRACER_PROVIDER_SYMBOL]
        }
        logger.debug('Tracer shutdown skipped — no active provider')
        return
    }

    // Pre-clear module state so concurrent shutdown calls don't double-call
    // forceFlush/shutdown on the same provider instance.
    provider = null
    tracer = null
    ownsProvider = false
    initialized = false

    try {
        await localProvider.forceFlush()
    } catch (err) {
        logger.error('Failed to flush tracer during shutdown', { error: err })
    }

    try {
        if (ownsLocal) {
            await localProvider.shutdown()
            delete (globalThis as typeof globalThis & { [TRACER_PROVIDER_SYMBOL]?: true })[TRACER_PROVIDER_SYMBOL]
        }
        logger.info('OpenTelemetry tracer shut down')
    } catch (err) {
        logger.error('Failed to shut down OpenTelemetry tracer', { error: err })
    }

    // Flush and reset the trace aggregator so buffered traces are emitted
    // before the SDK exits and the singleton is cleared for reinit.
    try {
        resetTraceAggregator()
    } catch (err) {
        logger.warn('Trace aggregator reset failed during shutdown', { error: err })
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

/**
 * Convert OTel SpanKind enum to a human-readable string for the event payload.
 * Critical for waterfall rendering and service map generation — without this,
 * the UI cannot distinguish incoming requests (SERVER) from outgoing calls (CLIENT).
 */
function spanKindToString(kind: SpanKind): 'internal' | 'server' | 'client' | 'producer' | 'consumer' {
    switch (kind) {
        case SpanKind.INTERNAL: return 'internal'
        case SpanKind.SERVER: return 'server'
        case SpanKind.CLIENT: return 'client'
        case SpanKind.PRODUCER: return 'producer'
        case SpanKind.CONSUMER: return 'consumer'
        default: return 'internal'
    }
}

function resolveWithSpanArgs<T>(
    fnOrOptions: ((span: PulseSpan) => T | Promise<T>) | SpanOptions,
    optionsOrFn?: SpanOptions | ((span: PulseSpan) => T | Promise<T>)
): { fn: (span: PulseSpan) => T | Promise<T>; options: SpanOptions | undefined } {
    if (typeof fnOrOptions === 'function') {
        return { fn: fnOrOptions, options: optionsOrFn as SpanOptions | undefined }
    }
    if (typeof optionsOrFn === 'function') {
        return { fn: optionsOrFn, options: fnOrOptions }
    }
    throw new TypeError('withSpan requires a callback function')
}

function resolveWithSpanSyncArgs<T>(
    fnOrOptions: ((span: PulseSpan) => T) | SpanOptions,
    optionsOrFn?: SpanOptions | ((span: PulseSpan) => T)
): { fn: (span: PulseSpan) => T; options: SpanOptions | undefined } {
    if (typeof fnOrOptions === 'function') {
        return { fn: fnOrOptions, options: optionsOrFn as SpanOptions | undefined }
    }
    if (typeof optionsOrFn === 'function') {
        return { fn: optionsOrFn, options: fnOrOptions }
    }
    throw new TypeError('withSpanSync requires a callback function')
}

function toOtelSpanOptions(options?: SpanOptions): OTelSpanOptions {
    const otelOptions: OTelSpanOptions = {}
    otelOptions.attributes = withRequestContextAttributes(options?.attributes)
    if (options?.startTime) otelOptions.startTime = options.startTime
    if (options?.links) otelOptions.links = PulseSpan.toOTelLinks(options.links)
    return otelOptions
}

function withRequestContextAttributes(attributes?: Attributes): Attributes {
    const requestCtx = getRequestContext()
    if (!requestCtx) return attributes ?? {}

    const tenantId = requestCtx.extra?.['tenantId']
    const enriched: Attributes = {
        ...(attributes ?? {}),
        [PULSE_CONTEXT_ATTRIBUTES.requestId]: requestCtx.requestId,
    }

    if (requestCtx.sessionId) enriched[PULSE_CONTEXT_ATTRIBUTES.sessionId] = requestCtx.sessionId
    if (requestCtx.userId) enriched[PULSE_CONTEXT_ATTRIBUTES.userId] = requestCtx.userId
    if (typeof tenantId === 'string' && tenantId) enriched[PULSE_CONTEXT_ATTRIBUTES.tenantId] = tenantId

    return enriched
}

function attrString(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined
}
