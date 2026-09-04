/**
 * Central event processing pipeline — async, non-blocking, priority-governed.
 *
 * Architecture:
 *   Every captured event flows through a deferred async pipeline:
 *     capture → accept → [setImmediate] → normalize → sanitize → enrich →
 *     dedup → scope → plugin processors → beforeSend → route → persist
 *
 * Lifecycle model:
 *   1. `enqueueEvent()` synchronously validates and accepts the event,
 *      returning an `EventReceipt` with `accepted` status and `eventId`.
 *   2. Processing is deferred via `setImmediate()` to avoid blocking the
 *      caller's request lifecycle (critical for low-latency capture).
 *   3. The `receipt.processed` promise resolves when async processing completes.
 *   4. `processEvent()` is a backward-compatible wrapper returning `boolean`.
 *
 * Persistence governance:
 *   Events are persisted selectively via `PersistenceGovernor`:
 *     - critical (errors, crashes): always persisted for crash recovery
 *     - important (spans, requests): persisted unless high memory pressure
 *     - transient (metrics, messages): persisted only under normal pressure
 *   This prevents disk I/O from becoming a throughput bottleneck at scale.
 *
 * Load shedding & Correlation Groups:
 *   The pipeline integrates with `LoadShedder` and `AdaptivePressureMonitor`
 *   to drop low-priority telemetry under system pressure at the correlation-group
 *   level before any expensive processing occurs.
 *
 * Quota Control:
 *   Integrated with `QuotaController` to gracefully suppress billable telemetry
 *   during exhaustion while preserving application execution and SDK runtime.
 *
 * Replay safety:
 *   Persisted events are replayed on SDK restart via `PersistentStorage`.
 *   The `PersistenceGovernor` bounds replay pressure by limiting what gets
 *   persisted in the first place.
 *
 * Each pipeline step is a pure function: (event) => event | null
 * Returning null drops the event from the pipeline.
 */

import type { SDKEvent, EventMetadata, Event } from '../types/event.js'
import type { RemoteConfigResponse } from '../types/config.js'
import { client } from './client.js'
import { getRequestContext, getSpanId, getTraceId } from './context.js'
import { eventQueue } from '../transport/queue.js'
import { normalizeEvent } from '../processors/normalizer.js'
import { sanitizeEvent } from '../processors/sanitizer.js'
import { getLogger } from '../utils/logger.js'
import { generateId } from '../utils/uuid.js'
import { epochMs } from '../utils/time.js'
import { errorDeduplicator } from '../processors/deduplicator.js'
import { applyScopeToEvent } from './scope.js'
import { loadShedder } from '../transport/load-shedder.js'
import { isSDKShuttingDown } from './lifecycle.js'
import { quotaController } from './quota-controller.js'
import {
  type EventReceipt,
  acceptedReceipt,
  acceptedSyncReceipt,
  rejectedReceipt,
} from './event-receipt.js'

// ─── Remote Config Engine Imports ───────────────────────────────────────────
import { KillswitchEngine } from './killswitch-engine.js'
import { SamplingEngine } from './sampling-engine.js'
import { EntitlementGate } from './entitlement-gate.js'
import { LimitsEngine } from './limits-engine.js'
import { TransportRouter } from '../transport/transport-router.js'
import { ConfigManager } from './config-manager.js'
import { ERROR_DEFAULTS } from '../constants/internal-defaults.js'
import { peekSessionManager } from '../session/session-manager.js'
import { tenantGovernor } from './tenant-isolation.js'
import { sdkConsoleDebug } from '../utils/console-debug.js'

const PLUGIN_TIMEOUT_MS = 50
const EVENT_PROCESSOR_TIMEOUT_MS = 50
const BEFORE_SEND_TIMEOUT_MS = 100
/**
 * Source-context attachment reads files from disk — bound it so slow I/O
 * can never stall the pipeline. On timeout the original frames are kept.
 */
const SOURCE_CONTEXT_TIMEOUT_MS = 250
/**
 * Hard cap on in-flight pipeline tasks. Under sustained load faster than
 * the pipeline drains, an unbounded set would exhaust memory; excess events
 * are rejected instead and counted in `pendingPipelineDrops`.
 */
const MAX_PENDING_PIPELINES = 10_000
const pendingPipelines = new Set<Promise<boolean>>()
let pendingPipelineDrops = 0

/**
 * Once set, no new event may join the pendingPipelines set — drain becomes
 * monotonic and is guaranteed to complete in finite time. New events arriving
 * after this flag is set are rejected synchronously by enqueueEvent().
 */
let pipelineDraining = false

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Accept an event into the processing pipeline and return an EventReceipt.
 *
 * This is the preferred entry point for event capture. It provides clear
 * async acceptance semantics:
 *
 * - `receipt.accepted` — event entered the pipeline (synchronous)
 * - `receipt.eventId` — assigned event ID for correlation
 * - `receipt.reason` — why the event was rejected (if `accepted === false`)
 * - `receipt.processed` — promise resolving when processing completes
 *
 * The pipeline is intentionally non-blocking. Processing is deferred via
 * `setImmediate()` to avoid blocking the caller's request lifecycle.
 */
export function enqueueEvent(rawEvent: SDKEvent | Event): EventReceipt {
  const logger = getLogger()
  const eventType = (rawEvent as Record<string, unknown>).type
  const eventId = (rawEvent.eventId && typeof rawEvent.eventId === 'string')
    ? rawEvent.eventId
    : generateId()
  const internalTelemetry = isInternalTelemetryEvent(rawEvent)
  sdkConsoleDebug('event accepted', {
    eventType,
    eventId,
    initialized: client.initialized,
    internalTelemetry,
  })

  // Gate 1: Reject events during shutdown
  if (isSDKShuttingDown() && !internalTelemetry) {
    logger.debug('Event rejected — telemetry is shutting down', { eventType })
    return rejectedReceipt(eventId, 'sdk_shutting_down')
  }

  // Gate 1.1: Reject new events once the pipeline has begun draining.
  if (pipelineDraining && !internalTelemetry) {
    return rejectedReceipt(eventId, 'pipeline_draining')
  }

  // Gate 1.5: Global killswitch — SDK disabled via remote config
  const killswitchEngine = KillswitchEngine.getInstance()
  if (killswitchEngine?.isSDKDisabled()) {
    return rejectedReceipt(eventId, 'sdk_disabled_by_killswitch')
  }

  // Synchronously resolve context IDs (traceId, spanId, requestId) so correlation groups are accurate
  const rawRecord = rawEvent as Record<string, unknown>
  const ctx = getRequestContext()
  const traceId = (typeof rawRecord['traceId'] === 'string' && rawRecord['traceId'])
    ? rawRecord['traceId']
    : ctx?.traceId ?? getTraceId()
  const spanId = (typeof rawRecord['spanId'] === 'string' && rawRecord['spanId'])
    ? rawRecord['spanId']
    : ctx?.spanId ?? getSpanId()
  const requestId = (typeof rawRecord['requestId'] === 'string' && rawRecord['requestId'])
    ? rawRecord['requestId']
    : ctx?.requestId

  const candidateEvent: Record<string, unknown> = {
    ...rawRecord,
    eventId,
    ...(traceId ? { traceId } : {}),
    ...(spanId ? { spanId } : {}),
    ...(requestId ? { requestId } : {}),
  }

  const priority = loadShedder.classifyEvent(candidateEvent)

  // Gate 1.8: Quota Controller check
  if (!quotaController.shouldAdmit(priority)) {
    logger.debug('Event rejected — quota exhausted', { eventType, priority })
    return rejectedReceipt(eventId, 'quota_exhausted')
  }

  // Gate 2: Load shedding under adaptive pressure with correlation groups
  if (loadShedder.shouldShed(candidateEvent)) {
    logger.debug('Event shed by load shedder', { eventType, priority })
    return rejectedReceipt(eventId, 'load_shed')
  }

  // Gate 4: Pre-init buffering — buffer without async processing
  if (!client.initialized) {
    const event = ensureBaseFields(candidateEvent as unknown as SDKEvent, eventId)
    if (!eventQueue.add(event as Event)) {
      logger.warn('Pre-init event rejected by queue', {
        eventType: event.type,
        eventId: event.eventId,
      })
      return rejectedReceipt(eventId, 'pre_init_queue_full')
    }
    logger.debug('Event buffered pre-init', {
      eventType: event.type,
      eventId: event.eventId,
    })
    return acceptedSyncReceipt(eventId)
  }

  // Accept: defer processing via setImmediate.
  let resolveProcessed!: (value: boolean) => void
  const pending = new Promise<boolean>(resolve => {
    resolveProcessed = resolve
  })

  if (pendingPipelines.size >= MAX_PENDING_PIPELINES) {
    pendingPipelineDrops++
    if (pendingPipelineDrops === 1 || pendingPipelineDrops % 1000 === 0) {
      logger.warn('Event rejected — pipeline overloaded', {
        eventType,
        maxPending: MAX_PENDING_PIPELINES,
        totalDrops: pendingPipelineDrops,
      })
    }
    return rejectedReceipt(eventId, 'pipeline_overloaded')
  }

  pendingPipelines.add(pending)

  setImmediate(() => {
    processEventAsync(candidateEvent as unknown as SDKEvent, eventId).then(
      result => {
        pendingPipelines.delete(pending)
        resolveProcessed(result)
      },
      error => {
        pendingPipelines.delete(pending)
        logger.error('Async event pipeline failed', { error })
        resolveProcessed(false)
      }
    )
  })

  return acceptedReceipt(eventId, pending)
}

/**
 * Process and enqueue an event through the full pipeline.
 *
 * **Backward-compatible wrapper** — returns `true` if the event was accepted
 * into the pipeline, `false` if it was synchronously rejected.
 */
export function processEvent(rawEvent: SDKEvent | Event): boolean {
  return enqueueEvent(rawEvent).accepted
}

/**
 * Drain all in-flight pipeline work to completion.
 */
export async function drainPendingEventProcessing(): Promise<void> {
  pipelineDraining = true
  try {
    while (pendingPipelines.size > 0) {
      await Promise.allSettled([...pendingPipelines])
    }
  } finally {
    pipelineDraining = false
  }
}

/**
 * Reset the pipeline-draining flag.
 */
export function resetEventPipeline(): void {
  pipelineDraining = false
  pendingPipelines.clear()
  pendingPipelineDrops = 0
}

/**
 * Async pipeline — processes a single event through all pipeline stages.
 */
export async function processEventAsync(rawEvent: SDKEvent | Event, assignedEventId?: string): Promise<boolean> {
  const logger = getLogger()

  try {
    const killswitch = KillswitchEngine.getInstance()
    if (killswitch?.isSDKDisabled()) {
      return false
    }

    let event = ensureBaseFields(rawEvent, assignedEventId)

    if (!client.initialized) {
      logger.debug('Event buffered pre-init', {
        eventType: event.type,
        eventId: event.eventId,
      })
      if (!eventQueue.add(event as Event)) {
        logger.warn('Pre-init event rejected by queue', {
          eventType: event.type,
          eventId: event.eventId,
        })
        return false
      }
      return true
    }

    const config = ConfigManager.getInstance().getConfig()

    if (!isFeatureEnabled(event, config)) {
      logger.debug('Event dropped — feature disabled by remote configuration', {
        eventType: event.type,
      })
      return false
    }

    if (!isEntitled(event)) {
      logger.debug('Event dropped — backend entitlement denied', { eventType: event.type })
      return false
    }

    if (!isSampled(event)) {
      logger.debug('Event dropped — remote sampling decision', { eventType: event.type })
      return false
    }

    const tenantId = extractTenantId(event)
    if (!tenantGovernor.admit(tenantId, isHighPriority(event))) {
      return false
    }

    const limitsEngineAsync = LimitsEngine.getInstance()
    if (limitsEngineAsync) {
      event = limitsEngineAsync.enforceAttributeLimits(event)
    }

    event = normalizeEvent(event, client.metadata)
    event = enrichFromContext(event)

    // Step 6.5: Error deduplication — suppress duplicate errors within window
    if (event.type === 'error' && 'fingerprint' in event && typeof event.fingerprint === 'string') {
      const eventRecord = event as unknown as Record<string, any>
      const tenantId = eventRecord['tenantId']
        ?? eventRecord['context']?.['tenantId']
        ?? getRequestContext()?.extra?.['tenantId']
        ?? eventRecord['tags']?.['tenantId']
        ?? 'global'
      const route = eventRecord['route']
        ?? eventRecord['transaction']
        ?? eventRecord['context']?.['route']
        ?? eventRecord['tags']?.['route']
        ?? eventRecord['url']
        ?? 'unknown'
      const statusCode = eventRecord['statusCode'] ?? ''
      const projectId = event.metadata?.projectId ?? client.metadata.projectId
      const release = event.metadata?.release ?? client.metadata.release
      const compositeKey = `${event.fingerprint}:${projectId}:${release}:${tenantId}:${route}:${statusCode}`
      if (errorDeduplicator.isDuplicate(compositeKey)) {
        logger.debug('Event dropped — duplicate error within suppression window', {
          fingerprint: event.fingerprint,
          eventType: event.type,
          eventId: event.eventId,
        })
        return false
      }
    }

    event = applyScopeToEvent(event as unknown as Record<string, unknown>) as unknown as SDKEvent

    // Attach source context to error stack frames
    if (event.type === 'error' && 'stack' in event && Array.isArray((event as unknown as Record<string, unknown>).stack)) {
      try {
        if (ERROR_DEFAULTS.attachSourceContext) {
          const { attachSourceContext } = await import('../processors/source-context.js')
          const enrichedFrames = await withTimeout(
            attachSourceContext((event as unknown as Record<string, unknown>).stack as import('../types/event.js').StackFrame[]),
            SOURCE_CONTEXT_TIMEOUT_MS,
            'attachSourceContext timed out'
          )
          event = { ...event, stack: enrichedFrames } as unknown as SDKEvent
        }
      } catch {
        // Best-effort
      }
    }

    // Plugin event processors
    for (const plugin of client.plugins) {
      if (plugin.processEvent) {
        try {
          const result = await withTimeout(
            Promise.resolve(plugin.processEvent(event)),
            PLUGIN_TIMEOUT_MS,
            `Plugin processEvent timed out: ${plugin.meta.name}`
          )
          if (result === null) {
            logger.debug('Event dropped by plugin', {
              pluginName: plugin.meta.name,
              eventType: event.type,
              eventId: event.eventId,
            })
            return false
          }
          event = result
        } catch (pluginError) {
          logger.warn('Plugin processEvent threw', {
            pluginName: plugin.meta.name,
            error: pluginError,
          })
        }
      }
    }

    // User-registered event processors
    for (const processor of client.eventProcessors) {
      try {
        const result = await withTimeout(
          Promise.resolve(processor(event)),
          EVENT_PROCESSOR_TIMEOUT_MS,
          'EventProcessor timed out'
        )
        if (result === null) {
          logger.debug('Event dropped by event processor', {
            eventType: event.type,
            eventId: event.eventId,
          })
          return false
        }
        event = result
      } catch (processorError) {
        logger.warn('EventProcessor threw', { error: processorError })
      }
    }

    // beforeSend hook (user-provided)
    if (client.options?.beforeSend) {
      try {
        const result = await withTimeout(
          Promise.resolve(client.options.beforeSend(event as unknown as Record<string, unknown>)),
          BEFORE_SEND_TIMEOUT_MS,
          'beforeSend timed out'
        )
        if (result === null) {
          logger.debug('Event dropped by beforeSend', {
            eventType: event.type,
            eventId: event.eventId,
          })
          return false
        }
        event = result as unknown as SDKEvent
      } catch (beforeSendError) {
        logger.warn('beforeSend threw', { error: beforeSendError })
      }
    }

    // Plugin beforeSend hooks
    for (const plugin of client.plugins) {
      if (plugin.beforeSend) {
        try {
          const result = await withTimeout(
            Promise.resolve(plugin.beforeSend(event)),
            BEFORE_SEND_TIMEOUT_MS,
            `Plugin beforeSend timed out: ${plugin.meta.name}`
          )
          if (result === null) {
            logger.debug('Event dropped by plugin beforeSend', {
              pluginName: plugin.meta.name,
              eventType: event.type,
            })
            return false
          }
          event = result
        } catch (pluginError) {
          logger.warn('Plugin beforeSend threw', {
            pluginName: plugin.meta.name,
            error: pluginError,
          })
        }
      }
    }

    event = { ...event, metadata: client.metadata } as SDKEvent

    // Step 12.5: Quota check before routing
    const priority = loadShedder.classifyEvent(event as unknown as Record<string, unknown>)
    if (!quotaController.shouldAdmit(priority)) {
      logger.debug('Event dropped — quota exhausted', {
        eventType: event.type,
        eventId: event.eventId,
      })
      return false
    }

    // Step 13: Route to the unified transport owner
    const transportRouter = TransportRouter.getInstance()
    if (!transportRouter || !transportRouter.send(event)) {
      logger.warn('Event rejected by transport router', {
        eventType: event.type,
        eventId: event.eventId,
      })
      return false
    }

    logger.debug('Event routed', {
      eventType: event.type,
      eventId: event.eventId,
    })
    sdkConsoleDebug('event routed', {
      eventType: event.type,
      eventId: event.eventId,
      metadata: event.metadata,
      traceId: 'traceId' in event ? event.traceId : undefined,
      spanId: 'spanId' in event ? event.spanId : undefined,
      requestId: 'requestId' in event ? event.requestId : undefined,
    })

    return true
  } catch (error) {
    logger.error('Event pipeline failed', { error })
    return false
  }
}

// ─── Internal Helpers ───────────────────────────────────────────────────────

function ensureBaseFields(raw: SDKEvent | Event, assignedEventId?: string): SDKEvent {
  const { __pulseInternal: _internal, ...payload } = raw as SDKEvent & { __pulseInternal?: boolean }
  const eventId = assignedEventId
    ?? ((payload.eventId && typeof payload.eventId === 'string') ? payload.eventId : generateId())
  const timestamp = ('timestamp' in payload && typeof payload.timestamp === 'number')
    ? payload.timestamp
    : epochMs()

  return { ...payload, eventId, timestamp } as SDKEvent
}

function isInternalTelemetryEvent(raw: SDKEvent | Event): boolean {
  return (raw as Record<string, unknown>)['__pulseInternal'] === true
}

function isEntitled(event: SDKEvent): boolean {
  switch (event.type) {
    case 'log': return EntitlementGate.isAllowed('logging')
    case 'profile': return EntitlementGate.isAllowed('profiling')
    case 'replay': return EntitlementGate.isAllowed('sessionReplay')
    case 'cron_checkin': return EntitlementGate.isAllowed('crons')
    default: return true
  }
}

function isSampled(event: SDKEvent): boolean {
  const sampling = SamplingEngine.getInstance()
  if (!sampling) return true

  switch (event.type) {
    case 'request':
      return sampling.shouldSampleRequest(event.requestId, event.route ?? event.url).sampled
    case 'error':
      return sampling.shouldSampleError(event.eventId ?? event.fingerprint ?? event.message).sampled
    case 'message':
      return sampling.shouldSampleMessage(event.eventId ?? event.message).sampled
    case 'metric':
      return sampling.shouldSampleMetric(event.eventId ?? `${event.metricName}:${serializeMetricTags(event.tags)}`).sampled
    case 'log':
      return sampling.shouldSampleLog(event.eventId ?? `${event.level}:${event.message}`).sampled
    case 'span':
      return sampling.shouldSampleSpan(`${event.traceId}:${event.spanId}`, routeFromAttributes(event.attributes)).sampled
    case 'trace':
      return sampling.shouldSampleTrace(event.traceId, event.rootSpan.attributes ? routeFromAttributes(event.rootSpan.attributes) : undefined).sampled
    case 'profile':
      return sampling.shouldSampleProfile(event.traceId ?? event.eventId ?? event.profileType).sampled
    case 'replay':
      return sampling.shouldSampleReplay(event.sessionId).sampled
    case 'cron_checkin':
      return sampling.shouldSampleCron(event.eventId ?? event.monitorSlug).sampled
    default: {
      const legacyEvent = event as Record<string, unknown>
      return sampling.shouldSampleEvent(typeof legacyEvent['eventId'] === 'string' ? legacyEvent['eventId'] : 'unknown-event').sampled
    }
  }
}

function serializeMetricTags(tags: Readonly<Record<string, string>> | undefined): string {
  if (!tags || Object.keys(tags).length === 0) return ''
  return Object.entries(tags)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join('&')
}

function routeFromAttributes(attributes: Readonly<Record<string, unknown>> | undefined): string | undefined {
  if (!attributes) return undefined
  for (const key of ['http.route', 'http.target', 'http.url', 'url.full', 'url.path']) {
    const value = attributes[key]
    if (typeof value === 'string' && value) return value
  }
  return undefined
}

function isFeatureEnabled(event: SDKEvent, config: Readonly<RemoteConfigResponse>): boolean {
  const features = config.features
  const killed = config.killswitches

  switch (event.type) {
    case 'error':
      return features.errors && !killed.disableErrors
    case 'request':
      return features.requestCapture && !killed.disableTracing
    case 'message':
      return !killed.disableSDK
    case 'metric':
      return features.metrics && !killed.disableMetrics
    case 'span':
    case 'trace':
      return features.tracing && !killed.disableTracing
    case 'log':
      return features.logging && !killed.disableLogs
    case 'profile':
      return features.profiling && !killed.disableProfiling
    case 'replay':
      return features.sessionReplay
    case 'cron_checkin':
      return features.crons
    default:
      return !killed.disableSDK
  }
}

function enrichFromContext(event: SDKEvent): SDKEvent {
  const ctx = getRequestContext()
  const traceId = getTraceId()
  const spanId = getSpanId()

  const enrichment: Record<string, unknown> = {}

  if (traceId && !('traceId' in event && event.traceId)) {
    enrichment['traceId'] = traceId
  }
  if (spanId && !('spanId' in event && event.spanId)) {
    enrichment['spanId'] = spanId
  }
  if (ctx?.requestId && event.type !== 'request') {
    enrichment['requestId'] = ctx.requestId
  }

  // Attach breadcrumbs to error and message events
  if ((event.type === 'error' || event.type === 'message') && !event.breadcrumbs) {
    const crumbs = ctx?.breadcrumbs.toArray() ?? []
    if (crumbs.length > 0) {
      enrichment['breadcrumbs'] = crumbs
    }
  }

  try {
    const sessionMgr = peekSessionManager()
    if (sessionMgr) {
      const sessionId = sessionMgr.getSessionId() ?? sessionMgr.getSession().id
      enrichment['sessionId'] = sessionId

      if (event.type === 'error') {
        sessionMgr.recordError()
      } else {
        sessionMgr.recordActivity()
      }
    }
  } catch {
    // Session tracking is best-effort
  }

  if (Object.keys(enrichment).length === 0) return event

  return { ...event, ...enrichment } as SDKEvent
}

function extractTenantId(event: SDKEvent): string | undefined {
  const record = event as unknown as Record<string, any>
  const value = record['tenantId']
    ?? record['context']?.['tenantId']
    ?? record['tags']?.['tenantId']
    ?? getRequestContext()?.extra?.['tenantId']
  return typeof value === 'string' && value.trim() ? value : undefined
}

function isHighPriority(event: SDKEvent | Event): boolean {
  const type = (event as Record<string, unknown>).type
  return type === 'error' || type === 'span'
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs)
        timer.unref?.()
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
