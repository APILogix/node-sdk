/**
 * TraceAggregator — collects individual span events and reconstructs
 * complete trace trees with embedded `children` arrays.
 *
 * ## Problem
 *
 * OTel's BatchSpanProcessor exports spans individually. A single trace
 * (e.g. GET /api/users that calls MongoDB, Redis, and an external API)
 * produces 4+ separate span events. These arrive at the backend as flat,
 * disconnected events — the backend must reconstruct the tree by grouping
 * on traceId and linking via parentSpanId.
 *
 * ## Solution
 *
 * This aggregator buffers spans by traceId. When the **root span** arrives
 * (the span with no parentSpanId), we know the trace is complete because
 * in Node.js's synchronous request lifecycle, child spans always end
 * before the parent. At that point, we build the tree and emit a single
 * `trace` event with the full hierarchy.
 *
 * ## Safety
 *
 * - **Memory bounded**: Maximum pending traces (default: 1000), LRU eviction
 * - **Timeout safety**: Orphaned traces (no root arrives) are flushed after
 *   a configurable timeout (default: 30s) as partial traces
 * - **Thread-safe**: Single-threaded Node.js, no locks needed
 * - **Graceful shutdown**: flushAll() emits whatever is buffered
 */

import { getLogger } from '../utils/logger.js'
import { processEvent } from '../core/event-pipeline.js'
import type { SpanEvent, EventMetadata } from '../types/event.js'

// ─── Types ──────────────────────────────────────────────────────────────────

/** A span with its reconstructed children hierarchy. */
export interface AggregatedSpan {
  readonly spanId: string
  readonly parentSpanId?: string | undefined
  readonly name: string
  readonly kind?: string | undefined
  readonly startTime: number
  readonly endTime: number
  readonly duration: number
  readonly exclusiveDuration?: number | undefined
  readonly status: string
  readonly statusMessage?: string | undefined
  readonly attributes?: Readonly<Record<string, unknown>> | undefined
  readonly events?: readonly { name: string; timestamp: number; attributes?: Readonly<Record<string, unknown>> }[] | undefined
  readonly links?: readonly { traceId: string; spanId: string; attributes?: Readonly<Record<string, unknown>> }[] | undefined
  readonly children: AggregatedSpan[]
}

/** Complete trace document with embedded span tree. */
export interface TraceDocument {
  readonly type: 'trace'
  readonly eventId: string
  readonly traceId: string
  readonly rootSpan: AggregatedSpan
  readonly spanCount: number
  readonly totalDuration: number
  readonly isPartial: boolean
  readonly metadata?: EventMetadata | undefined
  readonly requestId?: string | undefined
  readonly sessionId?: string | undefined
  readonly userId?: string | undefined
  readonly tenantId?: string | undefined
  /** Internal marker for event pipeline routing during shutdown flush. */
  readonly __pulseInternal: true
}

// ─── Internal State ─────────────────────────────────────────────────────────

interface PendingTrace {
  /** All buffered span events for this trace, keyed by spanId. */
  spans: Map<string, Record<string, unknown>>
  /** The root span event, if it has arrived. */
  rootSpan: Record<string, unknown> | null
  /** When this trace entry was first created (for timeout eviction). */
  createdAt: number
}

// ─── Configuration ──────────────────────────────────────────────────────────

export interface TraceAggregatorConfig {
  /**
   * Maximum number of pending traces in the buffer.
   * When exceeded, the oldest trace is evicted and flushed as partial.
   * Default: 1000
   */
  readonly maxPendingTraces?: number
  /**
   * Timeout in milliseconds for orphaned traces (root span never arrives).
   * After this timeout, whatever spans are buffered are flushed as a partial trace.
   * Default: 30000 (30 seconds)
   */
  readonly orphanTimeoutMs?: number
  /**
   * Sweep interval in milliseconds for checking orphaned traces.
   * Default: 10000 (10 seconds)
   */
  readonly sweepIntervalMs?: number
}

// ─── TraceAggregator ────────────────────────────────────────────────────────

export class TraceAggregator {
  private readonly pending = new Map<string, PendingTrace>()
  private readonly maxPendingTraces: number
  private readonly orphanTimeoutMs: number
  private readonly sweepIntervalMs: number
  private sweepTimer: ReturnType<typeof setInterval> | null = null

  constructor(config: TraceAggregatorConfig = {}) {
    this.maxPendingTraces = config.maxPendingTraces ?? 1000
    this.orphanTimeoutMs = config.orphanTimeoutMs ?? 30_000
    this.sweepIntervalMs = config.sweepIntervalMs ?? 10_000
  }

  /**
   * Start the background sweep timer for orphaned traces.
   * Must be called after SDK init. Timer is `.unref()`'d so it won't
   * prevent the process from exiting.
   */
  start(): void {
    if (this.sweepTimer) return
    this.sweepTimer = setInterval(() => this.sweepOrphans(), this.sweepIntervalMs)
    this.sweepTimer.unref()
  }

  /**
   * Stop the background sweep timer.
   */
  stop(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer)
      this.sweepTimer = null
    }
  }

  /**
   * Add a span event to the aggregator.
   *
   * If this span is the root (no parentSpanId), it triggers immediate
   * trace assembly and emission. Otherwise, the span is buffered until
   * the root arrives or the orphan timeout fires.
   *
   * @param spanEvent - The flat span event from PipelineSpanExporter
   */
  addSpan(spanEvent: Record<string, unknown>): void {
    const traceId = spanEvent.traceId as string
    const spanId = spanEvent.spanId as string
    const parentSpanId = spanEvent.parentSpanId as string | undefined

    if (!traceId || !spanId) return

    let trace = this.pending.get(traceId)
    if (!trace) {
      // Enforce memory bound — evict oldest if at capacity
      if (this.pending.size >= this.maxPendingTraces) {
        this.evictOldest()
      }
      trace = {
        spans: new Map(),
        rootSpan: null,
        createdAt: Date.now(),
      }
      this.pending.set(traceId, trace)
    }

    trace.spans.set(spanId, spanEvent)

    // Root span detection: no parentSpanId means this is the root.
    if (!parentSpanId) {
      trace.rootSpan = spanEvent
    }
  }

  /**
   * Flush the trace if its root span has arrived.
   * This is called by the exporter at the end of a batch process to ensure
   * all spans from the same batch are buffered before the trace is assembled.
   */
  flushIfComplete(traceId: string): void {
    const trace = this.pending.get(traceId)
    if (trace && trace.rootSpan) {
      this.flushTrace(traceId)
    }
  }

  /**
   * Flush all pending traces (for shutdown).
   * Emits whatever is buffered, marking incomplete traces as partial.
   */
  flushAll(): void {
    const traceIds = Array.from(this.pending.keys())
    for (const traceId of traceIds) {
      this.flushTrace(traceId)
    }
  }

  /**
   * Get the number of pending traces in the buffer.
   */
  get pendingCount(): number {
    return this.pending.size
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  /**
   * Build the span tree and emit a complete trace event.
   */
  private flushTrace(traceId: string): void {
    const trace = this.pending.get(traceId)
    if (!trace) return

    // Remove from pending before processing to prevent re-entry
    this.pending.delete(traceId)

    const logger = getLogger()

    try {
      const spans = Array.from(trace.spans.values())
      if (spans.length === 0) return

      // Find the root span — either the one we detected or find by missing parentSpanId
      let rootSpanEvent = trace.rootSpan
      if (!rootSpanEvent) {
        rootSpanEvent = spans.find(s => !s.parentSpanId) ?? null
      }

      const isPartial = !rootSpanEvent

      // If no root, pick the span with earliest startTime as synthetic root
      if (!rootSpanEvent) {
        rootSpanEvent = spans.reduce((earliest, s) => {
          const eStart = earliest.startTime as number
          const sStart = s.startTime as number
          return sStart < eStart ? s : earliest
        })
      }

      // Build the tree
      const rootAggregated = this.buildTree(rootSpanEvent, spans)

      // Calculate total duration from root
      const totalDuration = (rootSpanEvent.duration as number) ?? 0

      const traceDocument: TraceDocument = {
        type: 'trace',
        eventId: `trace_${traceId}`,
        traceId,
        rootSpan: rootAggregated,
        spanCount: spans.length,
        totalDuration,
        isPartial,
        metadata: rootSpanEvent.metadata as EventMetadata | undefined,
        requestId: rootSpanEvent.requestId as string | undefined,
        sessionId: rootSpanEvent.sessionId as string | undefined,
        userId: rootSpanEvent.userId as string | undefined,
        tenantId: rootSpanEvent.tenantId as string | undefined,
        __pulseInternal: true,
      }

      // Emit the aggregated trace event
      processEvent(traceDocument as unknown as import('../types/event.js').SDKEvent)

      logger.debug('Trace aggregated and emitted', {
        traceId,
        spanCount: spans.length,
        isPartial,
        totalDuration,
      })
    } catch (err) {
      logger.error('Failed to aggregate trace', { traceId, error: err })
    }
  }

  /**
   * Recursively build the span tree by matching parentSpanId → spanId.
   */
  private buildTree(rootEvent: Record<string, unknown>, allSpans: Record<string, unknown>[]): AggregatedSpan {
    const rootSpanId = rootEvent.spanId as string

    // Find direct children of this span
    const children = allSpans
      .filter(s => (s.parentSpanId as string) === rootSpanId)
      .sort((a, b) => (a.startTime as number) - (b.startTime as number))
      .map(child => this.buildTree(child, allSpans))

    return {
      spanId: rootSpanId,
      parentSpanId: rootEvent.parentSpanId as string | undefined,
      name: rootEvent.name as string,
      kind: rootEvent.kind as string | undefined,
      startTime: rootEvent.startTime as number,
      endTime: rootEvent.endTime as number,
      duration: rootEvent.duration as number,
      exclusiveDuration: rootEvent.exclusiveDuration as number | undefined,
      status: rootEvent.status as string,
      statusMessage: rootEvent.statusMessage as string | undefined,
      attributes: rootEvent.attributes as Record<string, unknown> | undefined,
      events: rootEvent.events as AggregatedSpan['events'],
      links: rootEvent.links as AggregatedSpan['links'],
      children,
    }
  }

  /**
   * Sweep for orphaned traces that have exceeded the timeout.
   */
  private sweepOrphans(): void {
    const now = Date.now()
    const toFlush: string[] = []

    for (const [traceId, trace] of this.pending) {
      if (now - trace.createdAt > this.orphanTimeoutMs) {
        toFlush.push(traceId)
      }
    }

    if (toFlush.length > 0) {
      const logger = getLogger()
      logger.debug(`Sweeping ${toFlush.length} orphaned traces`, {
        orphanTimeoutMs: this.orphanTimeoutMs,
      })
      for (const traceId of toFlush) {
        this.flushTrace(traceId)
      }
    }
  }

  /**
   * Evict the oldest pending trace to make room for a new one.
   */
  private evictOldest(): void {
    // Map iteration order is insertion order — first key is oldest
    const oldestTraceId = this.pending.keys().next().value
    if (oldestTraceId) {
      getLogger().debug('Evicting oldest pending trace due to buffer overflow', {
        traceId: oldestTraceId,
      })
      this.flushTrace(oldestTraceId as string)
    }
  }
}

// ─── Singleton ──────────────────────────────────────────────────────────────

let instance: TraceAggregator | null = null

/**
 * Get or create the singleton TraceAggregator instance.
 */
export function getTraceAggregator(config?: TraceAggregatorConfig): TraceAggregator {
  if (!instance) {
    instance = new TraceAggregator(config)
  }
  return instance
}

/**
 * Reset the singleton (for shutdown/reinit).
 */
export function resetTraceAggregator(): void {
  if (instance) {
    instance.stop()
    instance.flushAll()
    instance = null
  }
}
