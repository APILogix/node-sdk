import type { SDKEvent, Event } from '../types/event.js'
import type { TransportRetryConfig } from '../types/config.js'
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
import { persistenceGovernor } from '../storage/persistence-governor.js'
import { costGovernor } from '../utils/cost-governor.js'
import { compressGzip } from '../utils/compression.js'
import { inspectTelemetryResponse } from '../core/config-manager.js'
import { quotaController } from '../core/quota-controller.js'
import { toError } from '../core/errors.js'
import { sdkConsoleDebug } from '../utils/console-debug.js'
import { SerializationPool } from './serialization-pool.js'
import { safeJsonStringify } from '../utils/safe-json.js'

const WORKER_SERIALIZATION_THRESHOLD_BYTES = 50 * 1024 // 50KB

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
  /** Retained for config compatibility; telemetry batches are always sent gzip-compressed. */
  readonly compression: 'gzip' | 'none'
  readonly keepAlive: boolean
  readonly retry: TransportRetryConfig
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
  readonly totalRetries: number
  readonly totalRequests: number
  readonly avgBatchSize: number
}

const WARMUP_SUCCESS_THRESHOLD = 5
const MAX_BATCH_RETENTION_AGE_MS = 300_000 // 5 minutes max retention before dropping stale retries

export class BatchManager {
  private timer: ReturnType<typeof setTimeout> | null = null
  private activeSends = 0
  private readonly activeSendPromises = new Set<Promise<void>>()
  private readonly activeBatches = new Set<readonly SDKEvent[]>()
  private readonly activeAbortControllers = new Set<AbortController>()
  private readonly handedOffEvents = new WeakSet<object>()
  private readonly pendingRetryPromises = new Set<Promise<void>>()
  private readonly pendingRetryTimers = new Map<ReturnType<typeof setTimeout>, { events: SDKEvent[]; resolve: () => void }>()
  private readonly retryAttempts = new Map<string, number>()
  private readonly firstAttemptTimestamps = new Map<string, number>()
  private batched = 0
  private totalSent = 0
  private totalDropped = 0
  private totalFailed = 0
  private totalRetries = 0
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
    if (!accepted) return false
    const currentQueueSize = this.options.queue.size()
    const maxSize = this.options.queue.maxSize
    if (currentQueueSize <= 50 || (currentQueueSize < maxSize && currentQueueSize % 500 === 0)) {
      sdkConsoleDebug('event batched', {
        route: this.options.route,
        eventType: event.type,
        eventId: event.eventId,
        queueSize: currentQueueSize,
      })
    }
    sdkConsoleDebug('batch enqueue', {
      route: this.options.route,
      eventType: event.type,
      eventId: event.eventId,
      queueSize: this.options.queue.size(),
      minBatchSize: this.options.minBatchSize,
      maxBatchSize: this.options.maxBatchSize,
    })

    if (!this.firstQueuedAt) this.firstQueuedAt = Date.now()

    if (this.options.queue.size() >= this.effectiveMaxBatchSize()) {
      this.pump()
    } else {
      this.ensureTimer()
    }
    return true
  }

  /** Drain without event-loop polling; waits only on tracked work promises. */
  async flush(): Promise<void> {
    this.clearTimer()
    const deadline = Date.now() + 4_000
    const failedAtStart = this.totalFailed
    const droppedAtStart = this.totalDropped

    while (!this.options.queue.isEmpty() || this.activeSendPromises.size > 0 || this.pendingRetryPromises.size > 0) {
      this.pump(true)
      const work = [...this.activeSendPromises, ...this.pendingRetryPromises]
      if (work.length === 0) break
      const remainingMs = deadline - Date.now()
      if (remainingMs <= 0) break
      const completed = await settleWithin(work, remainingMs)
      if (!completed) break
      const newFailures = (this.totalFailed - failedAtStart) + (this.totalDropped - droppedAtStart)
      if (newFailures >= Math.max(5, this.options.retry.maxRetries + 1)) break
    }
  }

  /**
   * Stop new work, cancel delayed retries, abort active requests, and return
   * any batches that could not be quiesced within the bounded wait.
   */
  async shutdown(timeoutMs = 4_000): Promise<SDKEvent[]> {
    this.destroyed = true
    this.clearTimer()
    this.cancelPendingRetries()
    for (const controller of this.activeAbortControllers) controller.abort()

    const completed = await settleWithin([...this.activeSendPromises], Math.max(1, timeoutMs))
    this.cancelPendingRetries()
    if (completed) return []

    const residual = [...this.activeBatches].flatMap(events => [...events])
    for (const event of residual) this.handedOffEvents.add(event)
    return residual
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
      totalRetries: this.totalRetries,
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
      if (!batch) break
      this.activeSends++
      this.batched += batch.events.length
      this.activeBatches.add(batch.events)
      const sendPromise = this.sendBatch(batch)
      this.activeSendPromises.add(sendPromise)
      void sendPromise.then(
        () => this.activeSendPromises.delete(sendPromise),
        error => {
          this.activeSendPromises.delete(sendPromise)
          getLogger().warn('[TransportRouter] Unhandled batch send failure', { route: this.options.route, error })
        },
      )
    }
  }

  private nextSerializableBatch(): { events: SDKEvent[] } | null {
    const targetSize = this.effectiveMaxBatchSize()
    const batch = this.options.queue.drain(targetSize)
    if (batch.length === 0) return null
    return { events: batch }
  }

  private async sendBatch(batch: { events: SDKEvent[] }): Promise<void> {
    const startedAt = Date.now()
    const { events } = batch
    const lease = await this.options.connectionManager.acquire(this.options.route)
    if (!lease) {
      this.activeBatches.delete(events)
      this.activeSends--
      this.batched -= events.length
      this.totalFailed += events.length
      this.persistOnFailure(events, 'connection_acquire_failed')
      this.retryOrRetain(events)
      return
    }

    try {
      const isGzip = this.options.compression === 'gzip'
      const compressionAlgo = isGzip ? 'gzip' : 'none'
      const scrubber = SecurityScrubber.getInstance()
      const privacyConfig = scrubber?.getPrivacyConfig()
      const pool = SerializationPool.getInstance()

      let wireBody: Buffer
      let originalPayloadBytes: number

      try {
        let serializeResult: import('./serialization-pool.js').SerializeBatchResult
        if (pool) {
          serializeResult = await pool.serializeBatch({
            events,
            route: this.options.route,
            timestamp: Date.now(),
            privacyConfig,
            compression: compressionAlgo,
            maxPayloadBytes: this.options.maxPayloadBytes,
          })
        } else {
          const safeBatch = scrubber ? scrubber.scrubBatch(events) : events.map(e => sanitizeEvent(e))
          const payload = { events: safeBatch, route: this.options.route, timestamp: Date.now() }
          const jsonStr = safeJsonStringify(payload)
          const rawBuf = Buffer.from(jsonStr, 'utf8')
          const compressed = isGzip ? await compressGzip(rawBuf) : rawBuf
          serializeResult = {
            buffer: compressed,
            algorithm: compressionAlgo,
            originalSize: rawBuf.byteLength,
            compressedSize: compressed.byteLength,
            tooLarge: rawBuf.byteLength > this.options.maxPayloadBytes,
          }
        }

        if (serializeResult.tooLarge) {
          lease.release(true)
          this.activeBatches.delete(events)
          this.activeSends--
          this.batched -= events.length

          if (events.length === 1) {
            this.totalDropped++
            this.options.onDrop?.({
              route: this.options.route,
              reason: 'event_too_large',
              count: 1,
              eventType: events[0]?.type,
            })
            return
          }

          const half = Math.max(1, Math.floor(events.length / 2))
          const firstHalf = events.slice(0, half)
          const secondHalf = events.slice(half)
          this.options.queue.requeueFront(secondHalf)
          this.activeSends++
          this.batched += firstHalf.length
          this.activeBatches.add(firstHalf)
          const sendPromise = this.sendBatch({ events: firstHalf })
          this.activeSendPromises.add(sendPromise)
          void sendPromise.then(
            () => this.activeSendPromises.delete(sendPromise),
            error => {
              this.activeSendPromises.delete(sendPromise)
              getLogger().warn('[TransportRouter] Unhandled batch send failure', { route: this.options.route, error })
            },
          )
          return
        }

        wireBody = serializeResult.buffer
        originalPayloadBytes = serializeResult.originalSize
      } catch (serializeErr) {
        if (events.length > 1) {
          getLogger().warn('[TransportRouter] Batch serialization failed, isolating problematic events', {
            route: this.options.route,
            error: serializeErr,
            eventCount: events.length,
          })
          const validEvents: SDKEvent[] = []
          for (const ev of events) {
            try {
              const testSafe = scrubber ? scrubber.scrubBatch([ev]) : [sanitizeEvent(ev)]
              safeJsonStringify(testSafe[0])
              validEvents.push(ev)
            } catch {
              this.totalDropped++
              this.options.onDrop?.({
                route: this.options.route,
                reason: 'serialization_failed',
                count: 1,
                eventType: ev?.type,
              })
            }
          }
          lease.release(true)
          this.activeBatches.delete(events)
          this.activeSends--
          this.batched -= events.length
          if (validEvents.length > 0) {
            this.options.queue.requeueFront(validEvents)
          }
          return
        }

        lease.release(true)
        this.activeBatches.delete(events)
        this.activeSends--
        this.batched -= events.length
        this.totalDropped += events.length
        this.options.onDrop?.({
          route: this.options.route,
          reason: 'serialization_failed',
          count: events.length,
          eventType: events[0]?.type,
        })
        return
      }

      getLogger().debug('[TransportRouter] Batch captured', {
        route: this.options.route,
        eventCount: events.length,
        eventTypes: [...new Set(events.map(event => event.type))],
        queueSize: this.options.queue.size(),
        payloadBytes: originalPayloadBytes,
      })
      sdkConsoleDebug('batch captured', {
        route: this.options.route,
        eventCount: events.length,
        eventTypes: [...new Set(events.map(event => event.type))],
        payloadBytes: originalPayloadBytes,
      })
      sdkConsoleDebug('batch built', {
        route: this.options.route,
        eventCount: events.length,
        eventTypes: [...new Set(events.map(event => event.type))],
        payloadBytes: originalPayloadBytes,
      })

      const headers: Record<string, string> = {
        'Content-Type': this.options.definition.contentType,
        Authorization: `Bearer ${this.options.apiKey}`,
        'X-Route': this.options.route,
        'x-pulse-internal': '1',
        Connection: this.options.keepAlive ? 'keep-alive' : 'close',
        ...(isGzip ? { 'Content-Encoding': 'gzip' } : {}),
      }

      const controller = new AbortController()
      this.activeAbortControllers.add(controller)
      if (this.destroyed) {
        controller.abort()
      }
      const timeout = setTimeout(() => {
        controller.abort()
      }, this.options.socketTimeoutMs)
      timeout.unref?.()

      try {
        const requestBody = new ArrayBuffer(wireBody.byteLength)
        new Uint8Array(requestBody).set(wireBody)

        getLogger().debug('[TransportRouter] Sending batch', {
          route: this.options.route,
          method: this.options.definition.method,
          eventCount: events.length,
          eventTypes: [...new Set(events.map(event => event.type))],
          compression: 'gzip',
          configuredCompression: this.options.compression,
        })
      sdkConsoleDebug('batch sending', {
          route: this.options.route,
          method: this.options.definition.method,
          eventCount: events.length,
          eventTypes: [...new Set(events.map(event => event.type))],
          compression: 'gzip',
        })
        logTransportConsole('request', {
          route: this.options.route,
          method: this.options.definition.method,
          eventCount: events.length,
          eventTypes: [...new Set(events.map(event => event.type))],
          compression: 'gzip',
        })
        sdkConsoleDebug('batch send request', {
          route: this.options.route,
          method: this.options.definition.method,
          eventCount: events.length,
          eventTypes: [...new Set(events.map(event => event.type))],
          compression: 'gzip',
        })

        const response = await this.fetchImpl(this.options.definition.url, {
          method: this.options.definition.method,
          headers,
          body: requestBody,
          signal: controller.signal,
          redirect: 'manual',
        })

        const latency = Date.now() - startedAt

        // Inspect response status and headers for Quota Controller signals & Retry-After
        quotaController.inspectResponse(response.status, response.headers)

        logTransportConsole('response', {
          route: this.options.route,
          statusCode: response.status,
          ok: response.ok,
          latencyMs: latency,
          eventCount: events.length,
          contentType: response.headers.get('content-type') ?? undefined,
        })
        sdkConsoleDebug('batch send response', {
          route: this.options.route,
          statusCode: response.status,
          ok: response.ok,
          latencyMs: latency,
          eventCount: events.length,
        })

        if (response.ok) {
          this.options.healthMonitor.recordSuccess(this.options.route, latency)
          this.totalSent += events.length
          this.totalRequests++
          this.totalBatchEvents += events.length
          for (const event of events) {
            const key = event.eventId ?? ''
            this.retryAttempts.delete(key)
            this.firstAttemptTimestamps.delete(key)
          }
          costGovernor.recordBytesSent(originalPayloadBytes)
          this.discardOnSuccess(events)

          getLogger().debug('[TransportRouter] Batch send successful', {
            route: this.options.route,
            statusCode: response.status,
            latencyMs: latency,
            eventCount: events.length,
            payloadBytes: originalPayloadBytes,
            wireBytes: wireBody.byteLength,
          })
          sdkConsoleDebug('batch send successful', {
            route: this.options.route,
            statusCode: response.status,
            latencyMs: latency,
            eventCount: events.length,
            payloadBytes: originalPayloadBytes,
            wireBytes: wireBody.byteLength,
          })

          inspectTelemetryResponse(response)
          try {
            await response.text().catch(() => undefined)
          } catch {}
        } else if (response.status >= 500 || response.status === 429 || response.status === 408) {
          getLogger().warn('[TransportRouter] Retryable batch response', {
            route: this.options.route,
            statusCode: response.status,
            eventCount: events.length,
          })
          sdkConsoleDebug('batch send failed', {
            route: this.options.route,
            statusCode: response.status,
            retryable: true,
            failureKind: 'http_response',
            eventCount: events.length,
          })
          this.options.healthMonitor.recordFailure(this.options.route)
          this.totalFailed += events.length

          this.persistOnFailure(events, `http_${response.status}`)

          const retryAfterHeader = response.headers.get('retry-after')
          const retryAfterMs = retryAfterHeader ? parseRetryAfterHeader(retryAfterHeader) : null
          this.retryOrRetain(events, retryAfterMs)
        } else {
          getLogger().warn('[TransportRouter] Non-retryable batch response', {
            route: this.options.route,
            statusCode: response.status,
            eventCount: events.length,
          })
        sdkConsoleDebug('batch send failed', {
            route: this.options.route,
            statusCode: response.status,
            retryable: false,
            failureKind: 'http_response',
            eventCount: events.length,
          })
          this.options.healthMonitor.recordFailure(this.options.route)
          this.totalDropped += events.length
          for (const event of events) {
            const key = event.eventId ?? ''
            this.retryAttempts.delete(key)
            this.firstAttemptTimestamps.delete(key)
          }

          this.options.onDrop?.({
            route: this.options.route,
            reason: 'route_unavailable',
            count: events.length,
            eventType: events[0]?.type,
          })
        }
      } finally {
        clearTimeout(timeout)
        this.activeAbortControllers.delete(controller)
      }
    } catch (error) {
      const normalizedError = toError(error)
      const aborted = normalizedError.name === 'AbortError'
        || normalizedError.message.toLowerCase().includes('aborted')
      const abortReason = aborted ? (this.destroyed ? 'shutdown' : 'timeout') : undefined
      this.options.healthMonitor.recordFailure(this.options.route)
      this.totalFailed += events.length

      this.persistOnFailure(events, 'network_error')
      this.retryOrRetain(events)
      getLogger().warn('[TransportRouter] Batch send failed', {
        route: this.options.route,
        error: normalizedError,
        errorName: normalizedError.name,
        errorMessage: normalizedError.message,
        errorCode: getErrorCode(normalizedError),
        errorCause: summarizeErrorCause(normalizedError.cause),
        abortReason,
        aborted,
        eventCount: events.length,
      })
    } finally {
      this.activeBatches.delete(events)
      lease.release(true)
      this.activeSends--
      this.batched -= events.length
      this.firstQueuedAt = this.options.queue.isEmpty() ? 0 : Date.now()
      this.pump()
    }
  }

  private retryOrRetain(events: readonly SDKEvent[], retryAfterMs?: number | null): void {
    if (this.destroyed) {
      const retained = events.filter(event => !this.handedOffEvents.has(event))
      this.options.queue.requeueFront(retained)
      for (const event of events) {
        const key = event.eventId ?? ''
        this.retryAttempts.delete(key)
        this.firstAttemptTimestamps.delete(key)
      }
      return
    }
    if (!this.options.retry.enabled || this.options.retry.maxRetries <= 0) return

    const now = Date.now()
    const retryable: SDKEvent[] = []
    let highestAttempt = 0

    for (const event of events) {
      const key = event.eventId ?? ''
      const firstAttempt = this.firstAttemptTimestamps.get(key) ?? now
      if (!this.firstAttemptTimestamps.has(key)) {
        this.firstAttemptTimestamps.set(key, now)
      }

      // Drop poisoned/stale batches exceeding max retention age
      if (now - firstAttempt > MAX_BATCH_RETENTION_AGE_MS) {
        this.retryAttempts.delete(key)
        this.firstAttemptTimestamps.delete(key)
        this.totalDropped++
        this.options.onDrop?.({
          route: this.options.route,
          reason: 'route_unavailable',
          count: 1,
          eventType: event.type,
          eventId: event.eventId,
        })
        continue
      }

      const attempt = (this.retryAttempts.get(key) ?? 0) + 1
      if (attempt > this.options.retry.maxRetries) {
        this.retryAttempts.delete(key)
        this.firstAttemptTimestamps.delete(key)
        this.totalDropped++
        this.options.onDrop?.({
          route: this.options.route,
          reason: 'route_unavailable',
          count: 1,
          eventType: event.type,
          eventId: event.eventId,
        })
        continue
      }

      this.retryAttempts.set(key, attempt)
      highestAttempt = Math.max(highestAttempt, attempt)
      retryable.push(event)
    }

    if (retryable.length === 0) return

    this.totalRetries += retryable.length
    const delayMs = retryDelay(this.options.retry, highestAttempt, retryAfterMs)
    let resolveRetry!: () => void
    const pending = new Promise<void>(resolve => { resolveRetry = resolve })
    this.pendingRetryPromises.add(pending)

    const timer = setTimeout(() => {
      this.pendingRetryTimers.delete(timer)
      this.pendingRetryPromises.delete(pending)
      this.options.queue.requeueFront(retryable)
      if (!this.destroyed) this.ensureTimer(true)
      resolveRetry()
    }, delayMs)
    timer.unref?.()
    this.pendingRetryTimers.set(timer, { events: retryable, resolve: resolveRetry })
  }

  private cancelPendingRetries(): void {
    for (const [timer, pending] of this.pendingRetryTimers) {
      clearTimeout(timer)
      this.options.queue.requeueFront(pending.events)
      pending.resolve()
    }
    this.pendingRetryTimers.clear()
    this.pendingRetryPromises.clear()
  }

  private persistOnFailure(batch: readonly SDKEvent[], reason: string): void {
    try {
      if (!persistentStorage.isInitialized) return
      const survivable = batch.filter(event => persistenceGovernor.shouldPersist(event as Event))
      if (survivable.length > 0) {
        persistentStorage.persistBatch(survivable as readonly Event[])
      }
    } catch (error) {
      getLogger().debug('[TransportRouter] Failed to persist failed batch', {
        route: this.options.route,
        reason,
        eventCount: batch.length,
        error,
      })
    }
  }

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
    const warmed = this.totalRequests >= WARMUP_SUCCESS_THRESHOLD
      ? scaled
      : Math.min(scaled, this.totalRequests + 1)
    return Math.max(1, warmed)
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
      otelContext.with(suppressTracing(otelContext.active()), () => {
        this.pump(true)
      })
    }, waitMs)
    this.timer.unref?.()
  }

  private clearTimer(): void {
    if (!this.timer) return
    clearTimeout(this.timer)
    this.timer = null
  }
}

function getErrorCode(error: Error): unknown {
  return (error as Error & { code?: unknown }).code
}

function summarizeErrorCause(cause: unknown): Record<string, unknown> | string | undefined {
  if (cause === undefined) return undefined
  if (cause instanceof Error) {
    return {
      name: cause.name,
      message: cause.message,
      code: getErrorCode(cause),
    }
  }
  if (typeof cause === 'string') return cause
  if (cause && typeof cause === 'object') {
    const code = (cause as { code?: unknown }).code
    const message = (cause as { message?: unknown }).message
    return {
      type: cause.constructor?.name,
      ...(code !== undefined ? { code } : {}),
      ...(message !== undefined ? { message } : {}),
    }
  }
  return String(cause)
}

async function settleWithin(promises: readonly Promise<void>[], timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      Promise.allSettled(promises).then(() => true),
      new Promise<boolean>(resolve => {
        timer = setTimeout(() => resolve(false), timeoutMs)
        timer.unref?.()
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function logTransportConsole(direction: 'request' | 'response', details: Readonly<Record<string, unknown>>): void {
  if (process.env['PULSE_TRANSPORT_CONSOLE'] !== 'true') return
  const status = typeof details['statusCode'] === 'number' ? details['statusCode'] : undefined
  const count = typeof details['eventCount'] === 'number' ? details['eventCount'] : undefined
  console.log(`[Pulse transport] ${direction}`, {
    ...(status !== undefined ? { statusCode: status } : {}),
    ...(count !== undefined ? { eventCount: count } : {}),
  })
}

function retryDelay(config: TransportRetryConfig, attempt: number, retryAfterMs?: number | null): number {
  if (typeof retryAfterMs === 'number' && retryAfterMs > 0) {
    return Math.min(60_000, retryAfterMs)
  }
  const base = Math.max(0, config.baseDelayMs)
  let delay = base
  if (config.backoff === 'fixed') {
    delay = base
  } else if (config.backoff === 'linear') {
    delay = Math.min(30_000, base * attempt)
  } else {
    delay = Math.min(30_000, base * 2 ** Math.max(0, attempt - 1))
  }
  const jitter = 0.8 + Math.random() * 0.4
  return Math.max(50, Math.floor(delay * jitter))
}

function parseRetryAfterHeader(headerValue: string): number | null {
  const trimmed = headerValue.trim()
  if (!trimmed) return null
  const seconds = Number(trimmed)
  if (!Number.isNaN(seconds) && seconds >= 0) {
    return Math.min(3_600_000, Math.floor(seconds * 1000))
  }
  const dateMs = Date.parse(trimmed)
  if (!Number.isNaN(dateMs)) {
    const diff = dateMs - Date.now()
    return Math.max(0, Math.min(3_600_000, diff))
  }
  return null
}
