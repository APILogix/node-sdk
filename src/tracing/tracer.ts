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
    trace as otelTrace,
    type Tracer,
    type Span,
    type SpanOptions as OTelSpanOptions,
    SpanKind,
    type Attributes,
    type Context,
    context as otelContext,
    propagation,
    ROOT_CONTEXT,
    INVALID_SPAN_CONTEXT,
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
    AlwaysOnSampler,
    AlwaysOffSampler,
    type SpanExporter,
    type ReadableSpan,
    type SpanProcessor,
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
import { PulseSpan, type SpanOptions, type SpanLink, type SpanKindName } from './span.js'
import { getLogger } from '../utils/logger.js'
import { generateId } from '../utils/uuid.js'
import type { RemoteConfigResponse } from '../types/config.js'
import { processEvent, drainPendingEventProcessing } from '../core/event-pipeline.js'
import {
    getRequestContext,
    PULSE_CONTEXT_ATTRIBUTES,
    createContextStore,
    withContext,
} from '../core/context.js'
import { costGovernor } from '../utils/cost-governor.js'
import type { ResourceAttributes } from '../utils/resource-detector.js'
import { RemoteConfigSampler, LocalRecordSampler } from './remote-config-sampler.js'
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
function createNoopSpan(_name?: string): PulseSpan {
    return new PulseSpan(otelTrace.wrapSpanContext(INVALID_SPAN_CONTEXT))
}

/**
 * Custom developer spans are gated by the `customSpans` entitlement.
 * Revoked ⇒ every custom span API returns a non-recording noop span.
 * Automatic instrumentation is unaffected (it uses the OTel tracer
 * directly, not these developer-facing wrappers).
 */
function areCustomSpansAllowed(): boolean {
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
const convertedSpanCache = new WeakMap<ReadableSpan, Record<string, unknown>>()
const deniedSpanCache = new WeakSet<ReadableSpan>()

function getOrConvertSpanEvent(span: ReadableSpan): Record<string, unknown> | null {
    if (deniedSpanCache.has(span)) return null
    const existing = convertedSpanCache.get(span)
    if (existing) return existing

    const ctx = span.spanContext()
    if (!costGovernor.canCreateSpan(ctx.traceId) || !costGovernor.canContinueTrace(ctx.traceId)) {
        deniedSpanCache.add(span)
        return null
    }

    const parentSpanId = span.parentSpanContext?.spanId
    if (parentSpanId) {
        spanDurationTracker.recordChildInterval(
            ctx.traceId,
            parentSpanId,
            hrTimeToMs(span.startTime),
            hrTimeToMs(span.endTime),
        )
    }

    const event = spanToEvent(span)
    convertedSpanCache.set(span, event)
    return event
}

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

                for (const span of spans) {
                    const traceEvent = getOrConvertSpanEvent(span)
                    if (!traceEvent) continue

                    const ctx = span.spanContext()
                    const traceId = ctx.traceId
                    traceIdsInBatch.add(traceId)

                    const isSampled = (ctx.traceFlags & 1) === 1

                    // Only emit directly to event pipeline if head-sampled.
                    // Otherwise, the TraceAggregator will buffer and tail-promote if error or slow.
                    if (isSampled) {
                        if (!processEvent(traceEvent)) {
                            allAccepted = false
                        }
                    }
                }

                // Flush completed traces at the end of the batch export to prevent race conditions
                for (const traceId of traceIdsInBatch) {
                    try {
                        getTraceAggregator().flushIfComplete(traceId)
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

    async forceFlush(): Promise<void> {
        try {
            getTraceAggregator().flushAll()
        } catch {}
    }
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
function spanToEvent(span: ReadableSpan): Record<string, unknown> {
    const ctx = span.spanContext()
    const attrs = span.attributes
    const status = span.status
    const rawDurationMs = hrTimeToMs(span.duration)

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

    const rawStartTimeMs = hrTimeToMs(span.startTime)
    const rawEndTimeMs = hrTimeToMs(span.endTime)
    const childIntervals = spanDurationTracker.getChildIntervals(ctx.traceId, ctx.spanId)

    // Ensure parent span boundaries envelop all asynchronous child operations
    // so child intervals never exceed parent boundaries in distributed trace trees.
    let startTimeMs = rawStartTimeMs
    let endTimeMs = rawEndTimeMs
    if (childIntervals.length > 0) {
        for (const child of childIntervals) {
            if (child.startTime < startTimeMs) startTimeMs = child.startTime
            if (child.endTime > endTimeMs) endTimeMs = child.endTime
        }
    }
    const durationMs = Math.max(rawDurationMs, endTimeMs - startTimeMs)

    // Compute exclusive (self) duration by subtracting merged child
    // span intervals from this span's total duration. This enables
    // performance attribution: "DB took 50ms, business logic 400ms".
    const durationBreakdown = computeExclusiveDuration(startTimeMs, endTimeMs, childIntervals, span.name)

    return {
        type: 'span',
        eventId: generateId(),
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
        isSampled: (ctx.traceFlags & 1) === 1,
        traceFlags: ctx.traceFlags,
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
        requestId: toAttrString(attrs[PULSE_CONTEXT_ATTRIBUTES.requestId]),
        sessionId: toAttrString(attrs[PULSE_CONTEXT_ATTRIBUTES.sessionId]),
        userId: toAttrString(attrs[PULSE_CONTEXT_ATTRIBUTES.userId]),
        tenantId: toAttrString(attrs[PULSE_CONTEXT_ATTRIBUTES.tenantId]),
    }
}

/**
 * Synchronous SpanProcessor that hooks every span start and end in real time.
 * Participates directly in TraceAggregator lifecycle:
 *   - onStart: registers span with trace, tracking activeSpanCount
 *   - onEnd: records child interval, converts span to event, buffers in aggregator,
 *            and triggers state transitions (ROOT_ENDED -> QUIESCING -> FINALIZED)
 */
class AggregatorSpanProcessor implements SpanProcessor {
    onStart(span: Span, _parentContext: Context): void {
        try {
            const ctx = span.spanContext()
            if (ctx?.traceId && ctx?.spanId) {
                getTraceAggregator().onSpanStart(ctx.traceId, ctx.spanId)
            }
        } catch (err) {
            getLogger().debug('AggregatorSpanProcessor.onStart failed', { error: err })
        }
    }

    onEnd(span: ReadableSpan): void {
        try {
            const ctx = span.spanContext()
            if (!ctx?.traceId || !ctx?.spanId) return

            const traceEvent = getOrConvertSpanEvent(span)
            const isRoot = !span.parentSpanContext?.spanId

            if (traceEvent) {
                getTraceAggregator().addSpan(traceEvent)
            }
            // Always decrement activeSpanCount even if costGovernor blocked the span payload
            getTraceAggregator().onSpanEnd(ctx.traceId, ctx.spanId, isRoot)
        } catch (err) {
            getLogger().debug('AggregatorSpanProcessor.onEnd failed', { error: err })
        }
    }

    shutdown(): Promise<void> {
        return Promise.resolve()
    }

    forceFlush(): Promise<void> {
        return Promise.resolve()
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
            tracer = otelTrace.getTracer(SDK_NAME, SDK_VERSION)
            initialized = true
            ownsProvider = false
            logger.info('OpenTelemetry tracer provider already registered by APM telemetry; reusing global provider')
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
                localParentSampled: new AlwaysOnSampler(),
                localParentNotSampled: new LocalRecordSampler(),
                remoteParentSampled: new AlwaysOnSampler(),
                remoteParentNotSampled: new AlwaysOffSampler(),
            }),
            spanProcessors: [
                new AggregatorSpanProcessor(),
                new BatchSpanProcessor(new PipelineSpanExporter(), {
                    maxQueueSize: 2048,
                    maxExportBatchSize: 512,
                    scheduledDelayMillis: 2000,
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
        tracer = otelTrace.getTracer(SDK_NAME, SDK_VERSION)

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
 * `otelTrace.getActiveSpan()` would return the new span itself.
 */
function snapshotActiveSpanId(): string | undefined {
    try {
        return otelTrace.getActiveSpan()?.spanContext().spanId
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

    if (!areCustomSpansAllowed()) {
        logger.debug('startSpan called but customSpans entitlement is revoked — returning no-op span', { name })
        return createNoopSpan(name)
    }

    if (!tracer) {
        logger.debug('startSpan called but tracer is not initialized — returning no-op span', { name })
        return createNoopSpan(name)
    }

    try {
        const otelOptions = toOtelSpanOptions(options)
        const parentContext = resolveParentContext(options?.parent)
        const parentSpanId = resolveParentSpanId(options, parentContext)
        const span = parentContext
            ? tracer.startSpan(name, otelOptions, parentContext)
            : tracer.startSpan(name, otelOptions)
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
    if (!tracer || !areCustomSpansAllowed()) {
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
    const parentContext = resolveParentContext(options?.parent)
    const parentSpanId = resolveParentSpanId(options, parentContext)
    const isRoot = parentSpanId === undefined

    const runCallback = async (span: Span) => {
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
    }

    return parentContext
        ? tracer.startActiveSpan(name, otelOptions, parentContext, runCallback)
        : tracer.startActiveSpan(name, otelOptions, runCallback)
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
    if (!tracer || !areCustomSpansAllowed()) {
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
    const parentContext = resolveParentContext(options?.parent)
    const parentSpanId = resolveParentSpanId(options, parentContext)
    const isRoot = parentSpanId === undefined

    const runCallback = (span: Span) => {
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
    }

    return parentContext
        ? tracer.startActiveSpan(name, otelOptions, parentContext, runCallback)
        : tracer.startActiveSpan(name, otelOptions, runCallback)
}


/**
 * Execute a synchronous or asynchronous function within an active span.
 * Automatically detects whether the callback returns a Promise and tracks
 * the full asynchronous or synchronous duration.
 *
 * @example
 * ```ts
 * // Async usage
 * const user = await trace('db.getUser', () => UserModel.findById(id))
 *
 * // Sync usage
 * const hash = trace('crypto.hash', () => computeHash(data))
 * ```
 */
export function trace<T>(
    name: string,
    fnOrOptions: ((span: PulseSpan) => T | Promise<T>) | SpanOptions,
    optionsOrFn?: SpanOptions | ((span: PulseSpan) => T | Promise<T>)
): T | Promise<T> {
    const { fn, options } = resolveWithSpanArgs<T>(fnOrOptions as any, optionsOrFn as any)

    if (!tracer || !areCustomSpansAllowed()) {
        const span = startSpan(name, options)
        try {
            const result = fn(span)
            if (result && typeof (result as any).then === 'function') {
                return (result as Promise<any>).then(
                    (val) => {
                        span.setStatus('ok')
                        span.end()
                        return val
                    },
                    (err) => {
                        if (err instanceof Error) span.recordError(err)
                        span.setStatus('error', err instanceof Error ? err.message : String(err))
                        span.end()
                        throw err
                    }
                ) as Promise<T>
            }
            span.setStatus('ok')
            span.end()
            return result
        } catch (err) {
            if (err instanceof Error) span.recordError(err)
            span.setStatus('error', err instanceof Error ? err.message : String(err))
            span.end()
            throw err
        }
    }

    const otelOptions = toOtelSpanOptions(options)
    const parentContext = resolveParentContext(options?.parent)
    const parentSpanId = resolveParentSpanId(options, parentContext)
    const isRoot = parentSpanId === undefined

    const runCallback = (span: Span): T | Promise<T> => {
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
            if (result && typeof (result as any).then === 'function') {
                return (result as Promise<any>).then(
                    (val) => {
                        pulseSpan.setStatus('ok')
                        if (isRoot) {
                            try {
                                const subsystem = ProfilingSubsystem.getInstance()
                                if (subsystem) void subsystem.stopCpuProfile(pulseSpan.traceId)
                            } catch (err) {
                                getLogger().warn('Failed to stop CPU profile for root span', { error: err })
                            }
                        }
                        pulseSpan.end()
                        return val
                    },
                    (err) => {
                        if (err instanceof Error) pulseSpan.recordError(err)
                        pulseSpan.setStatus('error', err instanceof Error ? err.message : String(err))
                        if (isRoot) {
                            try {
                                const subsystem = ProfilingSubsystem.getInstance()
                                if (subsystem) void subsystem.stopCpuProfile(pulseSpan.traceId)
                            } catch (e) {
                                getLogger().warn('Failed to stop CPU profile for root span', { error: e })
                            }
                        }
                        pulseSpan.end()
                        throw err
                    }
                ) as Promise<T>
            }

            pulseSpan.setStatus('ok')
            if (isRoot) {
                try {
                    const subsystem = ProfilingSubsystem.getInstance()
                    if (subsystem) void subsystem.stopCpuProfile(pulseSpan.traceId)
                } catch (err) {
                    getLogger().warn('Failed to stop CPU profile for root span', { error: err })
                }
            }
            pulseSpan.end()
            return result
        } catch (err) {
            if (err instanceof Error) pulseSpan.recordError(err)
            pulseSpan.setStatus('error', err instanceof Error ? err.message : String(err))
            if (isRoot) {
                try {
                    const subsystem = ProfilingSubsystem.getInstance()
                    if (subsystem) void subsystem.stopCpuProfile(pulseSpan.traceId)
                } catch (e) {
                    getLogger().warn('Failed to stop CPU profile for root span', { error: e })
                }
            }
            pulseSpan.end()
            throw err
        }
    }

    return (parentContext
        ? tracer.startActiveSpan(name, otelOptions, parentContext, runCallback)
        : tracer.startActiveSpan(name, otelOptions, runCallback)) as T | Promise<T>
}

/**
 * Wrap a function so every invocation runs within an active span.
 * Works seamlessly for both synchronous and asynchronous functions, preserving
 * the original function's parameters, return type, and `this` context.
 *
 * @example
 * ```ts
 * const hashPassword = wrap('auth.hash', (password: string) => {
 *   return bcrypt.hash(password, 10)
 * })
 *
 * // Call anywhere - automatically traces:
 * const hashed = await hashPassword('secret')
 * ```
 */
export function wrap<F extends (...args: any[]) => any>(
    name: string,
    fn: F,
    options?: SpanOptions
): F {
    if (typeof fn !== 'function') {
        throw new TypeError('wrap requires a target function')
    }

    const wrapped = function (this: any, ...args: Parameters<F>): ReturnType<F> {
        return trace(name, () => fn.apply(this, args), options) as ReturnType<F>
    }

    Object.defineProperty(wrapped, 'name', {
        value: fn.name ? `pulseWrapped_${fn.name}` : `pulseWrapped_${name}`,
        configurable: true,
    })
    Object.defineProperty(wrapped, 'length', {
        value: fn.length,
        configurable: true,
    })

    return wrapped as F
}


// ─── Background / Detached Spans ──────────────────────────────────────────

export const MAX_CONCURRENT_BACKGROUND_SPANS = 1000
let activeBackgroundSpans = 0

/**
 * Get the current number of concurrently active background spans.
 */
export function getActiveBackgroundSpanCount(): number {
    return activeBackgroundSpans
}

/**
 * Options for creating detached background spans.
 */
export interface BackgroundSpanOptions {
    /** Custom attributes to attach to the background span. */
    attributes?: Attributes
    /** OpenTelemetry span kind. Defaults to SpanKind.INTERNAL. */
    kind?: SpanKindName
    /**
     * Originating parent or span to link to.
     * Defaults to the currently active span when withBackgroundSpan is invoked.
     */
    originatingSpan?: PulseSpan | Span | { traceId: string; spanId: string }
    /**
     * Explicit links in addition to the originating span link.
     */
    links?: SpanLink[]
    /**
     * Hard timeout for the background span in milliseconds.
     *
     * If the operation exceeds this deadline, the span is force-ended with an
     * ERROR status and a `pulse.span.timeout` event. User execution continues
     * uninterrupted (fail-open).
     */
    timeoutMs?: number
    /** ISO timestamp to use as span start time. */
    startTime?: import('@opentelemetry/api').TimeInput
}

function resolveWithBackgroundSpanArgs<T>(
    fnOrOptions: ((span: PulseSpan) => T | Promise<T>) | BackgroundSpanOptions,
    optionsOrFn?: BackgroundSpanOptions | ((span: PulseSpan) => T | Promise<T>)
): { fn: (span: PulseSpan) => T | Promise<T>; options: BackgroundSpanOptions | undefined } {
    if (typeof fnOrOptions === 'function') {
        return { fn: fnOrOptions, options: optionsOrFn as BackgroundSpanOptions | undefined }
    }
    if (typeof optionsOrFn === 'function') {
        return { fn: optionsOrFn, options: fnOrOptions }
    }
    throw new TypeError('withBackgroundSpan requires a callback function')
}

/**
 * Execute an asynchronous background task within a new detached root trace,
 * causally linked to the active (originating) span via OpenTelemetry SpanLink.
 *
 * ## Architecture & Motivation
 *
 * In web applications, asynchronous background tasks often outlive the HTTP
 * request lifecycle (e.g. fire-and-forget processing, email dispatch, webhooks,
 * queue publication).
 *
 * In naive implementations, two failure modes occur:
 *   1. If the background work is created as a child of the HTTP request span,
 *      the trace finalizes when the HTTP response ends (250ms safety deadline),
 *      and subsequent background spans are dropped by the anti-resurrection guard.
 *   2. If the HTTP span is kept alive until background work finishes, memory leaks
 *      occur (req/res/sockets held in memory, unbounded buffer growth).
 *
 * `withBackgroundSpan` solves both without compromising safety:
 *   - Starts a NEW independent root trace (`ROOT_CONTEXT`) with a fresh `traceId`.
 *   - Causally links to the originating span via standard OTel `SpanLink` with
 *     attribute `pulse.link.type: 'caused_by'`.
 *   - Sets `pulse.background: true`, `pulse.originating.trace_id`, and
 *     `pulse.originating.span_id` on the background root span.
 *   - Forks the SDK `ContextStore` (isolated breadcrumb buffer while preserving
 *     tenant/user/session correlation).
 *   - Bounded concurrency: capped at `MAX_CONCURRENT_BACKGROUND_SPANS` (1000) to
 *     prevent memory exhaustion under runaway background spawning.
 *   - Independent finalization: the HTTP trace finalizes promptly after `res.end()`,
 *     and the background trace finalizes independently when its own work finishes.
 */
export async function withBackgroundSpan<T>(
    name: string,
    fnOrOptions: ((span: PulseSpan) => T | Promise<T>) | BackgroundSpanOptions,
    optionsOrFn?: BackgroundSpanOptions | ((span: PulseSpan) => T | Promise<T>)
): Promise<T> {
    const { fn, options } = resolveWithBackgroundSpanArgs(fnOrOptions, optionsOrFn)
    const logger = getLogger()

    if (!tracer || !areCustomSpansAllowed()) {
        const span = createNoopSpan(name)
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

    if (activeBackgroundSpans >= MAX_CONCURRENT_BACKGROUND_SPANS) {
        logger.warn('Max concurrent background spans reached, executing untraced', {
            name,
            active: activeBackgroundSpans,
            limit: MAX_CONCURRENT_BACKGROUND_SPANS,
        })
        const span = createNoopSpan(name)
        return await fn(span)
    }

    // Resolve originating trace/span for causal linking
    let originatingTraceId: string | undefined
    let originatingSpanId: string | undefined

    if (options?.originatingSpan) {
        const orig = options.originatingSpan
        if (typeof (orig as any).traceId === 'string' && typeof (orig as any).spanId === 'string') {
            originatingTraceId = (orig as any).traceId
            originatingSpanId = (orig as any).spanId
        } else if (typeof (orig as any).spanContext === 'function') {
            const sc = (orig as any).spanContext()
            originatingTraceId = sc.traceId
            originatingSpanId = sc.spanId
        }
    } else {
        const activeSpan = otelTrace.getActiveSpan()
        if (activeSpan) {
            const sc = activeSpan.spanContext()
            originatingTraceId = sc.traceId
            originatingSpanId = sc.spanId
        }
    }

    const links: SpanLink[] = []
    if (originatingTraceId && originatingSpanId) {
        links.push({
            traceId: originatingTraceId,
            spanId: originatingSpanId,
            attributes: {
                'pulse.link.type': 'caused_by',
            },
        })
    }
    if (options?.links) {
        links.push(...options.links)
    }

    const attributes: Attributes = {
        ...(options?.attributes ?? {}),
        'pulse.background': true,
    }
    if (originatingTraceId) {
        attributes['pulse.originating.trace_id'] = originatingTraceId
    }
    if (originatingSpanId) {
        attributes['pulse.originating.span_id'] = originatingSpanId
    }

    const resolvedKind = (options?.kind ? toOtelSpanKind(options.kind) : undefined) ?? SpanKind.INTERNAL
    const otelOptions: OTelSpanOptions = {
        attributes: withRequestContextAttributes(attributes),
        kind: resolvedKind,
        links: PulseSpan.toOTelLinks(links),
    }
    if (options?.startTime !== undefined) {
        otelOptions.startTime = options.startTime
    }

    const currentStore = getRequestContext()

    const runCallback = async (span: Span) => {
        const pulseSpan = new PulseSpan(span, undefined)

        try {
            const subsystem = ProfilingSubsystem.getInstance()
            if (subsystem) void subsystem.startCpuProfile(pulseSpan.traceId, pulseSpan.spanId)
        } catch (err) {
            logger.warn('Failed to start CPU profile for background span', { error: err })
        }

        let timeoutTimer: NodeJS.Timeout | undefined
        if (options?.timeoutMs && options.timeoutMs > 0) {
            const timeoutMs = options.timeoutMs
            timeoutTimer = setTimeout(() => {
                if (!pulseSpan.isEnded) {
                    pulseSpan.addEvent('pulse.span.timeout', {
                        'pulse.timeout_ms': timeoutMs,
                    })
                    pulseSpan.setStatus('error', `Background span timed out after ${timeoutMs}ms`)
                    pulseSpan.end()
                    logger.warn('Background span force-ended due to timeout', {
                        name,
                        timeoutMs,
                        traceId: pulseSpan.traceId,
                        spanId: pulseSpan.spanId,
                    })
                }
            }, timeoutMs)
            timeoutTimer.unref()
        }

        const runWork = async () => {
            if (currentStore) {
                const bgStore = createContextStore(
                    `${currentStore.requestId}-bg-${Date.now().toString(36)}`,
                    100,
                    {
                        userId: currentStore.userId,
                        sessionId: currentStore.sessionId,
                        tags: currentStore.tags,
                        extra: currentStore.extra,
                    }
                )
                return withContext(bgStore, () => fn(pulseSpan))
            }
            return fn(pulseSpan)
        }

        try {
            const result = await runWork()
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
            try {
                const subsystem = ProfilingSubsystem.getInstance()
                if (subsystem) void subsystem.stopCpuProfile(pulseSpan.traceId)
            } catch (err) {
                logger.warn('Failed to stop CPU profile for background span', { error: err })
            }
            pulseSpan.end()
        }
    }

    activeBackgroundSpans++
    try {
        return await tracer.startActiveSpan(name, otelOptions, ROOT_CONTEXT, runCallback)
    } finally {
        activeBackgroundSpans = Math.max(0, activeBackgroundSpans - 1)
    }
}

/**
 * Manually start a detached background span.
 * The caller is responsible for calling `span.end()`.
 *
 * Note: To ensure child spans (like DB/HTTP calls) are attached to this
 * background span across async boundaries, `withBackgroundSpan(name, fn)`
 * is strongly recommended instead.
 */
export function startBackgroundSpan(name: string, options?: BackgroundSpanOptions): PulseSpan {
    const logger = getLogger()

    if (!areCustomSpansAllowed()) {
        logger.debug('startBackgroundSpan called but customSpans entitlement is revoked — returning no-op span', { name })
        return createNoopSpan(name)
    }

    if (!tracer) {
        logger.debug('startBackgroundSpan called but tracer is not initialized — returning no-op span', { name })
        return createNoopSpan(name)
    }

    if (activeBackgroundSpans >= MAX_CONCURRENT_BACKGROUND_SPANS) {
        logger.warn('Max concurrent background spans reached, returning no-op span', {
            name,
            active: activeBackgroundSpans,
            limit: MAX_CONCURRENT_BACKGROUND_SPANS,
        })
        return createNoopSpan(name)
    }

    try {
        let originatingTraceId: string | undefined
        let originatingSpanId: string | undefined

        if (options?.originatingSpan) {
            const orig = options.originatingSpan
            if (typeof (orig as any).traceId === 'string' && typeof (orig as any).spanId === 'string') {
                originatingTraceId = (orig as any).traceId
                originatingSpanId = (orig as any).spanId
            } else if (typeof (orig as any).spanContext === 'function') {
                const sc = (orig as any).spanContext()
                originatingTraceId = sc.traceId
                originatingSpanId = sc.spanId
            }
        } else {
            const activeSpan = otelTrace.getActiveSpan()
            if (activeSpan) {
                const sc = activeSpan.spanContext()
                originatingTraceId = sc.traceId
                originatingSpanId = sc.spanId
            }
        }

        const links: SpanLink[] = []
        if (originatingTraceId && originatingSpanId) {
            links.push({
                traceId: originatingTraceId,
                spanId: originatingSpanId,
                attributes: {
                    'pulse.link.type': 'caused_by',
                },
            })
        }
        if (options?.links) {
            links.push(...options.links)
        }

        const attributes: Attributes = {
            ...(options?.attributes ?? {}),
            'pulse.background': true,
        }
        if (originatingTraceId) {
            attributes['pulse.originating.trace_id'] = originatingTraceId
        }
        if (originatingSpanId) {
            attributes['pulse.originating.span_id'] = originatingSpanId
        }

        const resolvedKind = (options?.kind ? toOtelSpanKind(options.kind) : undefined) ?? SpanKind.INTERNAL
        const otelOptions: OTelSpanOptions = {
            attributes: withRequestContextAttributes(attributes),
            kind: resolvedKind,
            links: PulseSpan.toOTelLinks(links),
        }
        if (options?.startTime !== undefined) {
            otelOptions.startTime = options.startTime
        }

        const span = tracer.startSpan(name, otelOptions, ROOT_CONTEXT)
        activeBackgroundSpans++

        let decremented = false
        const maxLifetimeMs = options?.timeoutMs && options.timeoutMs > 0
            ? options.timeoutMs
            : TRACING_DEFAULTS.maxTraceDurationMs

        const safetyTimer = setTimeout(() => {
            if (!decremented) {
                decremented = true
                activeBackgroundSpans = Math.max(0, activeBackgroundSpans - 1)
            }
        }, maxLifetimeMs)
        safetyTimer.unref?.()

        const origOtelEnd = span.end.bind(span)
        span.end = (...args: Parameters<typeof span.end>) => {
            if (!decremented) {
                decremented = true
                clearTimeout(safetyTimer)
                activeBackgroundSpans = Math.max(0, activeBackgroundSpans - 1)
            }
            return origOtelEnd(...args)
        }

        const pulseSpan = new PulseSpan(span, undefined)
        const origPulseEnd = pulseSpan.end.bind(pulseSpan)
        pulseSpan.end = (endTime) => {
            if (!decremented) {
                decremented = true
                clearTimeout(safetyTimer)
                activeBackgroundSpans = Math.max(0, activeBackgroundSpans - 1)
            }
            origPulseEnd(endTime)
        }

        return pulseSpan
    } catch (err) {
        logger.warn('Failed to start background span', { name, error: err })
        return createNoopSpan(name)
    }
}

// ─── Active Span ────────────────────────────────────────────────────────────

/**
 * Get the currently active span (if any).
 */
export function getActiveSpan(): PulseSpan | null {
    const span = otelTrace.getActiveSpan()
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
        ownsProvider = false
        activeBackgroundSpans = 0
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
    activeBackgroundSpans = 0

    try {
        if (localProvider) {
            await localProvider.forceFlush()
        }
        try {
            getTraceAggregator().flushAll()
        } catch {}
    } catch (err) {
        logger.error('Failed to flush tracer during shutdown', { error: err })
    }

    try {
        if (ownsLocal && localProvider) {
            await localProvider.shutdown()
            delete (globalThis as typeof globalThis & { [TRACER_PROVIDER_SYMBOL]?: true })[TRACER_PROVIDER_SYMBOL]
            try {
                otelTrace.disable()
            } catch {}
            try {
                otelContext.disable()
            } catch {}
            try {
                propagation.disable()
            } catch {}
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
    try {
        costGovernor.reset()
    } catch {}
}

/**
 * Force-flush pending spans without shutting down.
 */
export async function flushTracer(): Promise<void> {
    if (!provider) return
    try {
        try {
            getTraceAggregator().flushAll()
        } catch {}
        await provider.forceFlush()
        try {
            getTraceAggregator().flushAll()
        } catch {}
        await drainPendingEventProcessing()
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
    if (options?.kind) {
        const kind = toOtelSpanKind(options.kind)
        if (kind !== undefined) {
            otelOptions.kind = kind
        }
    }
    if (options?.startTime) otelOptions.startTime = options.startTime
    if (options?.links) otelOptions.links = PulseSpan.toOTelLinks(options.links)
    return otelOptions
}

function toOtelSpanKind(kind?: import('./span.js').SpanKindName): SpanKind | undefined {
    switch (kind) {
        case 'internal': return SpanKind.INTERNAL
        case 'server': return SpanKind.SERVER
        case 'client': return SpanKind.CLIENT
        case 'producer': return SpanKind.PRODUCER
        case 'consumer': return SpanKind.CONSUMER
        default: return undefined
    }
}

function resolveParentContext(parent?: import('./span.js').SpanOptions['parent']): Context | undefined {
    if (!parent) return undefined
    if (typeof (parent as any).getValue === 'function' && typeof (parent as any).setValue === 'function') {
        return parent as Context
    }
    if (typeof (parent as any).getOTelSpan === 'function') {
        return otelTrace.setSpan(otelContext.active(), (parent as any).getOTelSpan())
    }
    if ((parent as any).otelSpan) {
        return otelTrace.setSpan(otelContext.active(), (parent as any).otelSpan)
    }
    if (typeof (parent as any).spanContext === 'function') {
        return otelTrace.setSpan(otelContext.active(), parent as Span)
    }
    if (typeof (parent as any).traceId === 'string' && typeof (parent as any).spanId === 'string') {
        const spanContext: import('@opentelemetry/api').SpanContext = {
            traceId: (parent as any).traceId,
            spanId: (parent as any).spanId,
            traceFlags: typeof (parent as any).traceFlags === 'number' ? (parent as any).traceFlags : 1,
            ...(typeof (parent as any).isRemote === 'boolean' ? { isRemote: (parent as any).isRemote } : {}),
            ...((parent as any).traceState ? { traceState: (parent as any).traceState } : {}),
        }
        return otelTrace.setSpanContext(otelContext.active(), spanContext)
    }
    return undefined
}

function resolveParentSpanId(options?: SpanOptions, parentContext?: Context): string | undefined {
    if (options?.parent) {
        const p = options.parent as any
        if (typeof p.spanId === 'string') return p.spanId
        if (typeof p.spanContext === 'function') return p.spanContext().spanId
        if (typeof p.getOTelSpan === 'function') return p.getOTelSpan().spanContext().spanId
    }
    if (parentContext) {
        try {
            const span = otelTrace.getSpan(parentContext)
            if (span) return span.spanContext().spanId
        } catch {}
    }
    return snapshotActiveSpanId()
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

function toAttrString(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined
}
