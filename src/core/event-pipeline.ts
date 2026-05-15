/**
 * Central event processing pipeline.
 *
 * Every captured event flows through this pipeline:
 *   capture → normalize → sanitize → enrich → plugin processors → beforeSend → sample → queue
 *
 * Each step is a pure function: (event) => event | null
 * Returning null drops the event from the pipeline.
 */

import type { SDKEvent, EventMetadata, Event } from '../types/event.js'
import { client } from './client.js'
import { getRequestContext } from './context.js'
import { eventQueue } from '../transport/queue.js'
import { normalizeEvent } from '../processors/normalizer.js'
import { sanitizeEvent } from '../processors/sanitizer.js'
import { getLogger } from '../utils/logger.js'
import { generateId } from '../utils/uuid.js'
import { epochMs } from '../utils/time.js'

/**
 * Process and enqueue an event through the full pipeline.
 * This is the single entry point for all event capture.
 *
 * Returns true if the event was queued, false if it was dropped.
 */
export function processEvent(rawEvent: SDKEvent | Event): boolean {
  const logger = getLogger()

  try {
    // Step 1: Coerce to SDKEvent shape + assign ID/timestamp
    let event = ensureBaseFields(rawEvent)

    // Step 2: Pre-init buffering — if SDK isn't ready, buffer without processing
    if (!client.initialized) {
      logger.debug('Event buffered pre-init', {
        eventType: event.type,
        eventId: event.eventId,
      })
      eventQueue.add(event as Event)
      return true
    }

    const config = client.config

    // Step 3: Feature flag gate
    if (!isFeatureEnabled(event, config)) {
      logger.debug('Event dropped — feature disabled', {
        eventType: event.type,
        enableErrors: config.enableErrors,
        enablePerformance: config.enablePerformance,
      })
      return false
    }

    // Step 4: Normalize — fill defaults, truncate oversized fields
    event = normalizeEvent(event, client.metadata)

    // Step 5: Sanitize — PII scrubbing
    event = sanitizeEvent(event)

    // Step 6: Enrich with request context (trace/span IDs, breadcrumbs)
    event = enrichFromContext(event)

    // Step 7: Plugin event processors
    for (const plugin of client.plugins) {
      if (plugin.processEvent) {
        try {
          const result = plugin.processEvent(event)
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
          // Plugin failures are isolated — log and continue
          logger.warn('Plugin processEvent threw', {
            pluginName: plugin.meta.name,
            error: pluginError,
          })
        }
      }
    }

    // Step 8: User-registered event processors
    for (const processor of client.eventProcessors) {
      try {
        const result = processor(event)
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

    // Step 9: beforeSend hook (user-provided)
    if (client.options?.beforeSend) {
      try {
        const result = client.options.beforeSend(event as unknown as Record<string, unknown>)
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

    // Step 10: Plugin beforeSend hooks
    for (const plugin of client.plugins) {
      if (plugin.beforeSend) {
        try {
          const result = plugin.beforeSend(event)
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

    // Step 11: Sampling (for request/performance events)
    if (event.type === 'request') {
      if (Math.random() > config.samplingRate) {
        logger.debug('Request event dropped by sampling', {
          samplingRate: config.samplingRate,
        })
        return false
      }
    }

    // Step 12: Enqueue
    eventQueue.add(event as Event)
    logger.debug('Event queued', {
      eventType: event.type,
      eventId: event.eventId,
      queueSize: eventQueue.size(),
    })

    return true
  } catch (error) {
    // The pipeline must NEVER crash the host application
    logger.error('Event pipeline failed', { error })
    return false
  }
}

// ─── Internal Helpers ───────────────────────────────────────────────────────

function ensureBaseFields(raw: SDKEvent | Event): SDKEvent {
  const event = raw as Record<string, unknown>

  if (!event['eventId'] || typeof event['eventId'] !== 'string') {
    event['eventId'] = generateId()
  }

  if (!event['timestamp'] || typeof event['timestamp'] !== 'number') {
    event['timestamp'] = epochMs()
  }

  return event as unknown as SDKEvent
}

function isFeatureEnabled(
  event: SDKEvent,
  config: { enableErrors: boolean; enablePerformance: boolean }
): boolean {
  switch (event.type) {
    case 'error':
      return config.enableErrors
    case 'request':
      return config.enablePerformance
    case 'message':
      return true // messages are always enabled
    case 'metric':
      return true // metrics are always enabled when captured
    default:
      return true
  }
}

function enrichFromContext(event: SDKEvent): SDKEvent {
  const ctx = getRequestContext()
  if (!ctx) return event

  const enrichment: Record<string, unknown> = {}

  if (ctx.traceId && !('traceId' in event && event.traceId)) {
    enrichment['traceId'] = ctx.traceId
  }
  if (ctx.spanId && !('spanId' in event && event.spanId)) {
    enrichment['spanId'] = ctx.spanId
  }
  if (ctx.requestId && event.type !== 'request') {
    enrichment['requestId'] = ctx.requestId
  }

  // Attach breadcrumbs to error and message events
  if ((event.type === 'error' || event.type === 'message') && !event.breadcrumbs) {
    const crumbs = ctx.breadcrumbs.toArray()
    if (crumbs.length > 0) {
      enrichment['breadcrumbs'] = crumbs
    }
  }

  if (Object.keys(enrichment).length === 0) return event

  return { ...event, ...enrichment } as SDKEvent
}
