/**
 * Event normalizer — ensures all events have required fields with safe defaults.
 * Truncates oversized strings and limits object depth to prevent memory issues.
 */

import type { SDKEvent, EventMetadata } from '../types/event.js'
import { generateId } from '../utils/uuid.js'
import { epochMs } from '../utils/time.js'

const MAX_STRING_LENGTH = 8192
const MAX_MESSAGE_LENGTH = 2048
const MAX_OBJECT_DEPTH = 5
const MAX_ARRAY_LENGTH = 100

/**
 * Normalize an event — fills in missing required fields, truncates oversized data.
 */
export function normalizeEvent(event: SDKEvent, metadata: EventMetadata): SDKEvent {
  // `timestamp` is present on every event variant except `TraceEvent`, which
  // carries timing on `rootSpan.startTime`. Read it via an unknown-cast so
  // the assignment stays compatible with the discriminated union.
  const existingTimestamp = (event as { timestamp?: unknown }).timestamp
  const base = {
    ...event,
    eventId: event.eventId || generateId(),
    timestamp: typeof existingTimestamp === 'number' && existingTimestamp > 0
      ? existingTimestamp
      : epochMs(),
    metadata: event.metadata ?? metadata,
  }

  switch (base.type) {
    case 'error':
      return {
        ...base,
        message: truncateString(base.message, MAX_MESSAGE_LENGTH),
        name: truncateString(base.name, 256),
        context: truncateObject(base.context, MAX_OBJECT_DEPTH) as Readonly<Record<string, unknown>>,
      }
    case 'request':
      return {
        ...base,
        url: truncateString(base.url, MAX_STRING_LENGTH),
        method: base.method.toUpperCase(),
      }
    case 'message':
      return {
        ...base,
        message: truncateString(base.message, MAX_MESSAGE_LENGTH),
        context: base.context
          ? truncateObject(base.context, MAX_OBJECT_DEPTH) as Readonly<Record<string, unknown>>
          : undefined,
      }
    case 'metric':
      return {
        ...base,
        metricName: truncateString(base.metricName, 256),
      }
    case 'span':
      return {
        ...base,
        name: truncateString(base.name, 256),
        attributes: base.attributes
          ? truncateObject(base.attributes, MAX_OBJECT_DEPTH) as Readonly<Record<string, unknown>>
          : undefined,
        events: base.events
          ? base.events.slice(0, MAX_ARRAY_LENGTH).map(e => ({
              ...e,
              name: truncateString(e.name, 256),
              attributes: e.attributes
                ? truncateObject(e.attributes, MAX_OBJECT_DEPTH) as Readonly<Record<string, unknown>>
                : undefined,
            }))
          : undefined,
      }
    default:
      return base
  }
}

/**
 * Truncate a string to a maximum length, appending '...[truncated]' if cut.
 */
function truncateString(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  return value.slice(0, maxLength - 14) + '...[truncated]'
}

/**
 * Deep-truncate an object, limiting depth, string lengths, and array sizes.
 *
 * Cycle-safe: a WeakSet tracks seen objects so user-supplied circular refs
 * (a real failure mode for context maps that include logger instances,
 * Express req objects, etc.) cannot stack-overflow the SDK.
 */
function truncateObject(value: unknown, maxDepth: number, currentDepth = 0, seen?: WeakSet<object>): unknown {
  if (currentDepth >= maxDepth) return '[max depth]'

  if (typeof value === 'string') {
    return truncateString(value, MAX_STRING_LENGTH)
  }

  if (typeof value !== 'object' || value === null) {
    return value
  }

  // Cycle guard — skip already-visited objects so the recursion terminates.
  const visited = seen ?? new WeakSet<object>()
  if (visited.has(value)) {
    return '[circular]'
  }
  visited.add(value)

  if (Array.isArray(value)) {
    const truncated = value.slice(0, MAX_ARRAY_LENGTH).map(
      item => truncateObject(item, maxDepth, currentDepth + 1, visited)
    )
    if (value.length > MAX_ARRAY_LENGTH) {
      truncated.push(`[...${value.length - MAX_ARRAY_LENGTH} more items]`)
    }
    return truncated
  }

  const result: Record<string, unknown> = {}
  for (const [key, nested] of Object.entries(value)) {
    // Defense-in-depth against prototype pollution from user-supplied keys.
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue
    result[key] = truncateObject(nested, maxDepth, currentDepth + 1, visited)
  }
  return result
}
