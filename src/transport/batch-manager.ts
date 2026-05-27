import type { SDKEvent, Event } from '../types/event.js'
import { getLogger } from '../utils/logger.js'
import { TransportEventQueue, type QueueDropInfo } from './transport-event-queue.js'
import { ConnectionManager } from './connection-manager.js'
import { HealthMonitor } from './health-monitor.js'
import type { EnterpriseRoute, RouteDefinition } from './route-registry.js'
import { context as otelContext } from '@opentelemetry/api'
import { suppressTracing } from '@opentelemetry/core'
import { SecurityScrubber } from '../processors/security-scrubber.js'
import { sanitizeEvent } from '../processors/sanitizer.js'
import { persistentStorage } from '../storage/persistent-storage.js'

export interface BatchManagerOptions {
  readonly route: EnterpriseRoute
  readonly definition: RouteDefinition
  readonly apiKey: string
  readonly queue: TransportEventQueue
  readonly connectionManager: ConnectionManager
  readonly healthMonitor: HealthMonitor
  readonly maxBatchSize: number
  readonly minBatchSize: number
  readonly maxWaitTimeMs: number
  readonly maxPayloadBytes: number
  readonly socketTimeoutMs: number
  readonly onDrop?: (info: QueueDropInfo) => void
  readonly fetchImpl?: typeof fetch
}

export interface BatchManagerStats {
  readonly route: EnterpriseRoute
  readonly queuedEvents: number
  readonly batchedEvents: number
  readonly inFlightSends: number
  readonly totalSent: number
  readonly totalDropped: number
  readonly totalFailed: number
  readonly totalRequests: number
  readonly avgBatchSize: number
}

export class BatchManager {
  private timer: ReturnType<typeof setTimeout> | null = null
  private activeSends = 0
  private batched = 0
  private totalSent = 0
  private totalDropped = 0
  private totalFailed = 0
  private totalRequests = 0
  private totalBatchEvents = 0
  private destroyed = false
  private firstQueuedAt = 0
  private readonly fetchImpl: typeof fetch

  constructor(private readonly options: BatchManagerOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  enqueue(event: SDKEvent): boolean {
    if (this.destroyed) return false
    const accepted = this.options.queue.enqueue(event)
    if (!accepted) {
      this.totalDropped++
      return false
    }

    if (!this.firstQueuedAt) this.firstQueuedAt = Date.now()

    if (this.options.queue.size() >= this.effectiveMaxBatchSize()) {
      this.pump()
    } else {
      this.ensureTimer()
    }
    return true
  }

  /**
   * Drain the queue. Bounded so a permanently-unreachable endpoint cannot
   * keep flush() spinning forever — re-queued failures eventually exhaust
   * the retry budget and the residual events are surrendered to the queue
   * for the upstream lifecycle/persistence layer to handle.
   */
  async flush(): Promise<void> {
    this.clearTimer()
    const FLUSH_DEADLINE_MS = 4_000  // Bounded so caller's outer timeout wins
    const FLUSH_MAX_FAILED_REQUESTS = 5
    const startedAt = Date.now()
    const failedAtStart = this.totalFailed
    const droppedAtStart = this.totalDropped

    while (!this.options.queue.isEmpty() || this.activeSends > 0) {
      this.pump(true)
      if (this.activeSends === 0 && this.options.queue.isEmpty()) break

      // Bail if the deadline has passed — the outer shutdown timeout will
      // surface this via stepErrors. Better than spinning forever.
      if (Date.now() - startedAt > FLUSH_DEADLINE_MS) break

      // Bail if we've accumulated too many failures during this single flush
      // cycle — the endpoint is unreachable and re-queuing is making the
      // problem worse. Surrender residual events to the caller (which
      // typically persists them to disk).
      const newFailures = (this.totalFailed - failedAtStart) + (this.totalDropped - droppedAtStart)
      if (newFailures >= FLUSH_MAX_FAILED_REQUESTS) break

      await sleep(10)
    }
  }

  async shutdown(): Promise<void> {
    this.destroyed = true
    await this.flush()
  }

  stats(): BatchManagerStats {
    return {
      route: this.options.route,
      queuedEvents: this.options.queue.size(),
      batchedEvents: this.batched,
      inFlightSends: this.activeSends,
      totalSent: this.totalSent,
      totalDropped: this.totalDropped + this.options.queue.droppedCount(),
      totalFailed: this.totalFailed,
      totalRequests: this.totalRequests,
      avgBatchSize: this.totalRequests > 0 ? this.totalBatchEvents / this.totalRequests : 0,
    }
  }

  private pump(force = false): void {
    if (this.destroyed && !force) return
    if (!this.options.healthMonitor.canSend(this.options.route)) {
      this.ensureTimer(true)
      return
    }

    const concurrency = this.effectiveConcurrency()
    while (this.activeSends < concurrency && !this.options.queue.isEmpty()) {
      if (!force && this.options.queue.size() < this.options.minBatchSize && !this.maxWaitElapsed()) {
        this.ensureTimer()
        break
      }

      const batch = this.nextSerializableBatch()
      if (batch.length === 0) break
      this.activeSends++
      this.batched += batch.length
      void this.sendBatch(batch)
    }
  }

  private nextSerializableBatch(): SDKEvent[] {
    const targetSize = this.effectiveMaxBatchSize()
    let batch = this.options.queue.drain(targetSize)
    while (batch.length > 0) {
      const scrubber = SecurityScrubber.getInstance()
      let safeBatch = batch
      if (scrubber) {
        safeBatch = scrubber.scrubBatch(batch)
      } else {
        safeBatch = batch.map(e => sanitizeEvent(e))
      }

      const payloadBytes = this.byteLength(safeBatch)

      // Sentinel: serialization itself failed (e.g., circular ref). The
      // bad events have already been dropped+reported by byteLength, so
      // don't requeue or try to split — that would re-serialize the same
      // bad payload and double-count the drop in stats.
      if (payloadBytes < 0) return []

      if (payloadBytes <= this.options.maxPayloadBytes) return safeBatch

      if (batch.length === 1) {
        this.totalDropped++
        this.options.onDrop?.({
          route: this.options.route,
          reason: 'event_too_large',
          count: 1,
          eventType: batch[0]?.type,
        })
        return []
      }

      const half = Math.max(1, Math.floor(batch.length / 2))
      const overflow = batch.splice(half)
      this.options.queue.requeueFront(overflow)
    }
    return []
  }

  private async sendBatch(batch: SDKEvent[]): Promise<void> {
    const startedAt = Date.now()
    const lease = await this.options.connectionManager.acquire(this.options.route)
    if (!lease) {
      this.activeSends--
      this.batched -= batch.length
      this.totalFailed += batch.length
      // Connection-pool starvation is a transient failure (rate-limited or
      // socket-saturated). Persist so a process crash before the next pump
      // doesn't lose the batch, then re-queue for the next tick.
      this.persistOnFailure(batch, 'connection_acquire_failed')
      this.options.queue.requeueFront(batch)
      this.ensureTimer(true)
      return
    }

    try {
      const body = JSON.stringify({
        events: batch,
        route: this.options.route,
        timestamp: Date.now(),
      })
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), this.options.socketTimeoutMs)
      timeout.unref?.()

      try {
        // suppressTracing prevents OTel HttpInstrumentation from creating a
        // span for our own batch send. Without this, every export of N
        // events produces N+1 spans, which themselves export, causing
        // unbounded fan-out. The static URL ignore list in
        // auto-instrument.ts is defense-in-depth for the same problem.
        const response = await otelContext.with(
          suppressTracing(otelContext.active()),
          () =>
            this.fetchImpl(this.options.definition.url, {
              method: this.options.definition.method,
              headers: {
                'Content-Type': this.options.definition.contentType,
                Authorization: `Bearer ${this.options.apiKey}`,
                'X-Route': this.options.route,
                'x-pulse-internal': '1',
              },
              body,
              signal: controller.signal,
            }),
        )

        const latency = Date.now() - startedAt
        if (response.ok) {
          this.options.healthMonitor.recordSuccess(this.options.route, latency)
          this.totalSent += batch.length
          this.totalRequests++
          this.totalBatchEvents += batch.length
          // ACK: backend confirmed delivery. Remove the batch from disk if
          // it had been persisted on a previous failed attempt. discard()
          // is async (it rewrites the NDJSON file) but we do not await it
          // here — the send pipeline must not block on filesystem latency.
          // The write chain inside persistentStorage serializes discards
          // safely.
          this.discardOnSuccess(batch)
        } else if (response.status >= 500 || response.status === 429 || response.status === 408) {
          this.options.healthMonitor.recordFailure(this.options.route)
          this.totalFailed += batch.length
          // Retry-eligible failure: persist before re-queue so a crash
          // between now and the next attempt doesn't lose the batch.
          this.persistOnFailure(batch, `http_${response.status}`)
          this.options.queue.requeueFront(batch)
        } else {
          this.options.healthMonitor.recordFailure(this.options.route)
          this.totalDropped += batch.length
          // Non-retryable failure (4xx other than 408/429). The backend
          // has rejected the batch and a retry would just be re-rejected.
          // Do NOT persist — replaying a permanent rejection forever is a
          // bug. Drop the batch and notify the dropper.
          this.options.onDrop?.({
            route: this.options.route,
            reason: 'route_unavailable',
            count: batch.length,
            eventType: batch[0]?.type,
          })
        }
      } finally {
        clearTimeout(timeout)
      }
    } catch (error) {
      this.options.healthMonitor.recordFailure(this.options.route)
      this.totalFailed += batch.length
      // Network-level failure (DNS, TCP reset, abort, fetch rejection).
      // The backend never saw the request, so retry is safe. Persist so a
      // crash before retry doesn't drop the batch.
      this.persistOnFailure(batch, 'network_error')
      this.options.queue.requeueFront(batch)
      getLogger().warn('[TransportRouter] Batch send failed', {
        route: this.options.route,
        error: error instanceof Error ? error.message : String(error),
        eventCount: batch.length,
      })
    } finally {
      lease.release(true)
      this.activeSends--
      this.batched -= batch.length
      this.firstQueuedAt = this.options.queue.isEmpty() ? 0 : Date.now()
      this.pump()
    }
  }

  /**
   * Persist a batch to disk after a transient send failure.
   *
   * Called on network errors, retry-eligible HTTP failures (5xx, 429, 408),
   * and connection-acquisition starvation. NOT called on 4xx permanent
   * rejections — those are dropped because replaying them forever is a bug.
   *
   * Persistence is best-effort and never throws to the caller. The batch
   * is still re-queued in memory by the caller; persistence is purely
   * defense against process crash before the in-memory retry succeeds.
   */
  private persistOnFailure(batch: readonly SDKEvent[], reason: string): void {
    try {
      if (persistentStorage.isInitialized) {
        persistentStorage.persistBatch(batch as readonly Event[])
      }
    } catch (error) {
      // Persistence failure on the failure path is genuinely best-effort.
      // We've already counted the batch as failed; logging here is enough.
      getLogger().debug('[TransportRouter] Failed to persist failed batch', {
        route: this.options.route,
        reason,
        eventCount: batch.length,
        error,
      })
    }
  }

  /**
   * Discard delivered events from durable storage after backend ACK.
   *
   * Fire-and-forget: the rewrite is serialized through the storage write
   * chain, so completion order is correct, but we do not await here so a
   * slow filesystem cannot block the send pipeline. A crash before the
   * discard write hits disk leaves the events on disk and produces a
   * single duplicate replay on the next start — which the backend MUST
   * dedupe by `eventId` per the at-least-once delivery contract.
   */
  private discardOnSuccess(batch: readonly SDKEvent[]): void {
    if (!persistentStorage.isInitialized) return
    void persistentStorage.discard(batch as readonly Event[]).catch(error => {
      getLogger().debug('[TransportRouter] Failed to discard delivered batch', {
        route: this.options.route,
        eventCount: batch.length,
        error,
      })
    })
  }

  private effectiveMaxBatchSize(): number {
    const scaled = Math.floor(this.options.maxBatchSize * this.options.healthMonitor.batchScale(this.options.route))
    return Math.max(1, scaled)
  }

  private effectiveConcurrency(): number {
    const limit = this.options.connectionManager.maxForRoute(this.options.route)
    const scaled = Math.floor(limit * this.options.healthMonitor.concurrencyScale(this.options.route))
    return Math.max(1, scaled)
  }

  private maxWaitElapsed(): boolean {
    if (!this.firstQueuedAt) return false
    return Date.now() - this.firstQueuedAt >= this.effectiveMaxWaitMs()
  }

  private effectiveMaxWaitMs(forceExtended = false): number {
    const state = this.options.healthMonitor.snapshot(this.options.route).healthState
    return forceExtended || state !== 'HEALTHY'
      ? this.options.maxWaitTimeMs * 2
      : this.options.maxWaitTimeMs
  }

  private ensureTimer(extended = false): void {
    if (this.timer) return
    const waitMs = this.effectiveMaxWaitMs(extended)
    this.timer = setTimeout(() => {
      this.timer = null
      this.pump(true)
    }, waitMs)
    this.timer.unref?.()
  }

  private clearTimer(): void {
    if (!this.timer) return
    clearTimeout(this.timer)
    this.timer = null
  }

  /**
   * Compute the JSON-encoded payload size for a batch.
   *
   * Returns a negative sentinel (-1) on serialization failure so callers can
   * distinguish "payload too large" from "payload not serializable" and
   * avoid re-serializing the same bad batch (which would double-count the
   * dropped events in stats).
   *
   * On serialization failure we drop the entire batch in one go and emit
   * a single onDrop notification with reason='serialization_failed'.
   */
  private byteLength(events: readonly SDKEvent[]): number {
    try {
      return Buffer.byteLength(JSON.stringify({ events, route: this.options.route, timestamp: Date.now() }))
    } catch {
      this.totalDropped += events.length
      this.options.onDrop?.({
        route: this.options.route,
        reason: 'serialization_failed',
        count: events.length,
        eventType: events[0]?.type,
      })
      return -1
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
