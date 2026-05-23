/**
 * Central event processing pipeline — async, non-blocking, priority-governed.
 *
 * Architecture:
 *   Every captured event flows through a deferred async pipeline:
 *     capture → accept → [setImmediate] → normalize → sanitize → enrich →
 *     dedup → scope → plugin processors → beforeSend → enqueue → persist
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
 * Load shedding:
 *   The pipeline integrates with `LoadShedder` and `AdaptivePressureMonitor`
 *   to drop low-priority telemetry under system pressure before any expensive
 *   processing occurs.
 *
 * Replay safety:
 *   Persisted events are replayed on SDK restart via `PersistentStorage`.
 *   The `PersistenceGovernor` bounds replay pressure by limiting what gets
 *   persisted in the first place.
 *
 * Each pipeline step is a pure function: (event) => event | null
 * Returning null drops the event from the pipeline.
 */
import { client } from './client.js';
import { getRequestContext, getSpanId, getTraceId } from './context.js';
import { eventQueue } from '../transport/queue.js';
import { normalizeEvent } from '../processors/normalizer.js';
import { sanitizeEvent } from '../processors/sanitizer.js';
import { getLogger } from '../utils/logger.js';
import { generateId } from '../utils/uuid.js';
import { epochMs } from '../utils/time.js';
import { errorDeduplicator } from '../processors/deduplicator.js';
import { applyScopeToEvent } from './scope.js';
import { persistentStorage } from '../storage/persistent-storage.js';
import { persistenceGovernor } from '../storage/persistence-governor.js';
import { loadShedder } from '../transport/load-shedder.js';
import { isSDKShuttingDown } from './lifecycle.js';
import { acceptedReceipt, acceptedSyncReceipt, rejectedReceipt, } from './event-receipt.js';
// ─── Remote Config Engine Imports ───────────────────────────────────────────
import { KillswitchEngine } from './killswitch-engine.js';
import { LimitsEngine } from './limits-engine.js';
import { SecurityScrubber } from '../processors/security-scrubber.js';
import { TransportRouter } from '../transport/transport-router.js';
import { FeatureController } from './feature-controller.js';
const PLUGIN_TIMEOUT_MS = 50;
const EVENT_PROCESSOR_TIMEOUT_MS = 50;
const BEFORE_SEND_TIMEOUT_MS = 100;
const CRITICAL_HEAP_RATIO = 0.92;
const pendingPipelines = new Set();
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
 *
 * @example
 * ```ts
 * const receipt = enqueueEvent(event)
 * if (!receipt.accepted) {
 *   logger.warn('Event dropped:', receipt.reason)
 * }
 * // Only await if you need confirmation (e.g., shutdown/flush):
 * await receipt.processed
 * ```
 */
export function enqueueEvent(rawEvent) {
    const logger = getLogger();
    const eventType = rawEvent.type;
    const eventId = (rawEvent.eventId && typeof rawEvent.eventId === 'string')
        ? rawEvent.eventId
        : generateId();
    // Gate 1: Reject events during shutdown
    if (isSDKShuttingDown()) {
        logger.debug('Event rejected — SDK is shutting down', { eventType });
        return rejectedReceipt(eventId, 'sdk_shutting_down');
    }
    // Gate 1.5: Global killswitch — SDK disabled via remote config
    const killswitchEngine = KillswitchEngine.getInstance();
    if (killswitchEngine?.isSDKDisabled()) {
        return rejectedReceipt(eventId, 'sdk_disabled_by_killswitch');
    }
    // Gate 1.6: Token-bucket rate limiter from limits engine
    const limitsEngine = LimitsEngine.getInstance();
    if (limitsEngine && !limitsEngine.admitEvent()) {
        return rejectedReceipt(eventId, 'rate_limited');
    }
    // Gate 2: Critical memory pressure — only high-priority events survive
    if (isCriticalMemoryPressure() && !isHighPriority(rawEvent)) {
        logger.warn('Event dropped under critical memory pressure', {
            eventType,
            heap: process.memoryUsage(),
        });
        return rejectedReceipt(eventId, 'critical_memory_pressure');
    }
    // Gate 3: Load shedding under adaptive pressure
    if (loadShedder.shouldShed(rawEvent)) {
        logger.debug('Event shed by load shedder', { eventType });
        return rejectedReceipt(eventId, 'load_shed');
    }
    // Gate 4: Pre-init buffering — buffer without async processing
    if (!client.initialized) {
        const event = ensureBaseFields(rawEvent, eventId);
        if (!eventQueue.add(event)) {
            logger.warn('Pre-init event rejected by queue', {
                eventType: event.type,
                eventId: event.eventId,
            });
            return rejectedReceipt(eventId, 'pre_init_queue_full');
        }
        logger.debug('Event buffered pre-init', {
            eventType: event.type,
            eventId: event.eventId,
        });
        return acceptedSyncReceipt(eventId);
    }
    // Accept: defer processing via setImmediate
    const pending = new Promise(resolve => {
        setImmediate(() => {
            processEventAsync(rawEvent, eventId).then(resolve, error => {
                logger.error('Async event pipeline failed', { error });
                resolve(false);
            });
        });
    });
    pendingPipelines.add(pending);
    pending.finally(() => {
        pendingPipelines.delete(pending);
    }).catch(error => {
        logger.error('Async event pipeline failed', { error });
    });
    return acceptedReceipt(eventId, pending);
}
/**
 * Process and enqueue an event through the full pipeline.
 *
 * **Backward-compatible wrapper** — returns `true` if the event was accepted
 * into the pipeline, `false` if it was synchronously rejected.
 *
 * For explicit lifecycle tracking, use `enqueueEvent()` which returns an
 * `EventReceipt` with async processing status.
 *
 * @deprecated Prefer `enqueueEvent()` for new code — it provides clear
 * async acceptance semantics via `EventReceipt`.
 */
export function processEvent(rawEvent) {
    return enqueueEvent(rawEvent).accepted;
}
export async function drainPendingEventProcessing() {
    while (pendingPipelines.size > 0) {
        await Promise.allSettled([...pendingPipelines]);
    }
}
/**
 * Async pipeline — processes a single event through all pipeline stages.
 *
 * Used internally by `enqueueEvent()` and by OTel exporters that need
 * backpressure-aware event ingestion.
 */
export async function processEventAsync(rawEvent, assignedEventId) {
    const logger = getLogger();
    try {
        // Step 1: Coerce to SDKEvent shape + assign ID/timestamp
        let event = ensureBaseFields(rawEvent, assignedEventId);
        // Step 2: Pre-init buffering — if SDK isn't ready, buffer without processing
        if (!client.initialized) {
            logger.debug('Event buffered pre-init', {
                eventType: event.type,
                eventId: event.eventId,
            });
            if (!eventQueue.add(event)) {
                logger.warn('Pre-init event rejected by queue', {
                    eventType: event.type,
                    eventId: event.eventId,
                });
                return false;
            }
            return true;
        }
        const config = client.config;
        // Step 3: Feature flag gate (plan-enforced + remote config FeatureController)
        if (!isFeatureEnabled(event, config)) {
            logger.debug('Event dropped — feature disabled by config or plan', {
                eventType: event.type,
                plan: config.plan,
            });
            return false;
        }
        // Step 3.5: Enforce attribute limits from remote config
        const limitsEngineAsync = LimitsEngine.getInstance();
        if (limitsEngineAsync) {
            event = limitsEngineAsync.enforceAttributeLimits(event);
        }
        // Step 4: Normalize — fill defaults, truncate oversized fields
        event = normalizeEvent(event, client.metadata);
        // Step 5: Sanitize — PII scrubbing via remote-config-driven SecurityScrubber
        const securityScrubber = SecurityScrubber.getInstance();
        if (securityScrubber) {
            event = securityScrubber.scrub(event);
        }
        else {
            // Fallback to legacy sanitizer if SecurityScrubber not initialized
            event = sanitizeEvent(event);
        }
        // Step 6: Enrich with request context (trace/span IDs, breadcrumbs)
        event = enrichFromContext(event);
        // Step 6.5: Error deduplication — suppress duplicate errors within window
        if (event.type === 'error' && 'fingerprint' in event && typeof event.fingerprint === 'string') {
            const tenantId = getRequestContext()?.extra?.['tenantId'] || event.tags?.['tenantId'] || 'global';
            const route = event.transaction || event.tags?.['route'] || 'unknown';
            const compositeKey = `${event.fingerprint}:${tenantId}:${route}`;
            if (errorDeduplicator.isDuplicate(compositeKey)) {
                logger.debug('Event dropped — duplicate error within suppression window', {
                    fingerprint: event.fingerprint,
                    eventType: event.type,
                    eventId: event.eventId,
                });
                return false;
            }
        }
        // Step 7: Apply scope (request-local or global fallback, user, tags, extra, contexts)
        event = applyScopeToEvent(event);
        // Step 8: Plugin event processors
        for (const plugin of client.plugins) {
            if (plugin.processEvent) {
                try {
                    const result = await withTimeout(Promise.resolve(plugin.processEvent(event)), PLUGIN_TIMEOUT_MS, `Plugin processEvent timed out: ${plugin.meta.name}`);
                    if (result === null) {
                        logger.debug('Event dropped by plugin', {
                            pluginName: plugin.meta.name,
                            eventType: event.type,
                            eventId: event.eventId,
                        });
                        return false;
                    }
                    event = result;
                }
                catch (pluginError) {
                    // Plugin failures are isolated — log and continue
                    logger.warn('Plugin processEvent threw', {
                        pluginName: plugin.meta.name,
                        error: pluginError,
                    });
                }
            }
        }
        // Step 9: User-registered event processors
        for (const processor of client.eventProcessors) {
            try {
                const result = await withTimeout(Promise.resolve(processor(event)), EVENT_PROCESSOR_TIMEOUT_MS, 'EventProcessor timed out');
                if (result === null) {
                    logger.debug('Event dropped by event processor', {
                        eventType: event.type,
                        eventId: event.eventId,
                    });
                    return false;
                }
                event = result;
            }
            catch (processorError) {
                logger.warn('EventProcessor threw', { error: processorError });
            }
        }
        // Step 10: beforeSend hook (user-provided)
        if (client.options?.beforeSend && config.planFeatures.allowBeforeSend) {
            try {
                const result = await withTimeout(Promise.resolve(client.options.beforeSend(event)), BEFORE_SEND_TIMEOUT_MS, 'beforeSend timed out');
                if (result === null) {
                    logger.debug('Event dropped by beforeSend', {
                        eventType: event.type,
                        eventId: event.eventId,
                    });
                    return false;
                }
                event = result;
            }
            catch (beforeSendError) {
                logger.warn('beforeSend threw', { error: beforeSendError });
            }
        }
        // Step 11: Plugin beforeSend hooks
        for (const plugin of client.plugins) {
            if (plugin.beforeSend && config.planFeatures.allowBeforeSend) {
                try {
                    const result = await withTimeout(Promise.resolve(plugin.beforeSend(event)), BEFORE_SEND_TIMEOUT_MS, `Plugin beforeSend timed out: ${plugin.meta.name}`);
                    if (result === null) {
                        logger.debug('Event dropped by plugin beforeSend', {
                            pluginName: plugin.meta.name,
                            eventType: event.type,
                        });
                        return false;
                    }
                    event = result;
                }
                catch (pluginError) {
                    logger.warn('Plugin beforeSend threw', {
                        pluginName: plugin.meta.name,
                        error: pluginError,
                    });
                }
            }
        }
        // Step 12: Sampling is owned by OTel samplers at root span creation.
        // Child spans inherit OTel's sampled flag. Non-span SDK events follow the
        // active span context rather than making independent random decisions.
        // Step 13: Enqueue
        if (!eventQueue.add(event)) {
            logger.warn('Event rejected by queue', {
                eventType: event.type,
                eventId: event.eventId,
                queueSize: eventQueue.size(),
            });
            return false;
        }
        // Step 14: Priority-aware persistence for crash recovery
        // Critical events always persist; transient telemetry skips under pressure
        if (persistenceGovernor.shouldPersist(event)) {
            persistentStorage.persist(event);
        }
        logger.debug('Event queued', {
            eventType: event.type,
            eventId: event.eventId,
            queueSize: eventQueue.size(),
        });
        return true;
    }
    catch (error) {
        // The pipeline must NEVER crash the host application
        logger.error('Event pipeline failed', { error });
        return false;
    }
}
// ─── Internal Helpers ───────────────────────────────────────────────────────
function ensureBaseFields(raw, assignedEventId) {
    // Defensive copy — never mutate the caller's object reference
    const eventId = assignedEventId
        ?? ((raw.eventId && typeof raw.eventId === 'string') ? raw.eventId : generateId());
    const timestamp = ('timestamp' in raw && typeof raw.timestamp === 'number')
        ? raw.timestamp
        : epochMs();
    return { ...raw, eventId, timestamp };
}
function isFeatureEnabled(event, config) {
    // Check FeatureController first (remote-config driven)
    const featureCtrl = FeatureController.getInstance();
    const killswitchEngine = KillswitchEngine.getInstance();
    switch (event.type) {
        case 'error':
            if (killswitchEngine?.isKilled('disableErrors'))
                return false;
            if (featureCtrl && !featureCtrl.isEnabled('errors'))
                return false;
            return config.enableErrors;
        case 'request':
            return config.enablePerformance;
        case 'message':
            return true; // messages are always enabled
        case 'metric':
            if (killswitchEngine?.isKilled('disableMetrics'))
                return false;
            if (featureCtrl && !featureCtrl.isEnabled('metrics'))
                return false;
            return config.enableMetrics;
        case 'span':
            if (killswitchEngine?.isKilled('disableTracing'))
                return false;
            if (featureCtrl && !featureCtrl.isEnabled('tracing'))
                return false;
            return config.enableTracing;
        case 'log':
            if (killswitchEngine?.isKilled('disableLogs'))
                return false;
            if (featureCtrl && !featureCtrl.isEnabled('logging'))
                return false;
            return true;
        case 'profile':
            if (killswitchEngine?.isKilled('disableProfiling'))
                return false;
            if (featureCtrl && !featureCtrl.isEnabled('profiling'))
                return false;
            return true;
        case 'replay':
            if (featureCtrl && !featureCtrl.isEnabled('sessionReplay'))
                return false;
            return true;
        case 'cron_checkin':
            if (featureCtrl && !featureCtrl.isEnabled('crons'))
                return false;
            return true;
        default:
            return true;
    }
}
function enrichFromContext(event) {
    const ctx = getRequestContext();
    const traceId = getTraceId();
    const spanId = getSpanId();
    if (!ctx && !traceId && !spanId)
        return event;
    const enrichment = {};
    if (traceId && !('traceId' in event && event.traceId)) {
        enrichment['traceId'] = traceId;
    }
    if (spanId && !('spanId' in event && event.spanId)) {
        enrichment['spanId'] = spanId;
    }
    if (ctx?.requestId && event.type !== 'request') {
        enrichment['requestId'] = ctx.requestId;
    }
    // Attach breadcrumbs to error and message events
    if ((event.type === 'error' || event.type === 'message') && !event.breadcrumbs) {
        const crumbs = ctx?.breadcrumbs.toArray() ?? [];
        if (crumbs.length > 0) {
            enrichment['breadcrumbs'] = crumbs;
        }
    }
    if (Object.keys(enrichment).length === 0)
        return event;
    return { ...event, ...enrichment };
}
function isCriticalMemoryPressure() {
    const usage = process.memoryUsage();
    if (usage.heapTotal <= 0)
        return false;
    return usage.heapUsed / usage.heapTotal >= CRITICAL_HEAP_RATIO;
}
function isHighPriority(event) {
    const type = event.type;
    return type === 'error' || type === 'span';
}
async function withTimeout(promise, timeoutMs, message) {
    let timer;
    try {
        return await Promise.race([
            promise,
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error(message)), timeoutMs);
                timer.unref?.();
            }),
        ]);
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
}
//# sourceMappingURL=event-pipeline.js.map