/**
 * RouteTransportManager — manages a single transport route (e.g., 'errors', 'traces').
 *
 * Each route has its own:
 * - Batching buffer with configurable batchSize and flushIntervalMs
 * - Queue with maxSize and overflow strategy (drop_oldest)
 * - Retry logic with exponential backoff
 * - Independent failure domain (one route failing doesn't affect others)
 * - Per-route compression setting
 * - Per-route priority and timeout
 */

import type { TransportEndpointConfig, TransportRouteName, TransportSharedConfig } from '../types/config.js'
import type { RouteTransportHealth } from '../types/transport.js'
import type { SDKEvent } from '../types/event.js'
import { getLogger } from '../utils/logger.js'

export class RouteTransportManager {
  readonly route: TransportRouteName
  private endpointConfig: TransportEndpointConfig
  private sharedConfig: TransportSharedConfig
  private apiKey: string

  // Batching
  private buffer: SDKEvent[] = []
  private flushTimer: ReturnType<typeof setInterval> | null = null

  // Queue (bounded)
  private queue: SDKEvent[][] = []

  // Stats
  private totalSent: number = 0
  private totalFailed: number = 0
  private totalDropped: number = 0
  private totalRetries: number = 0
  private lastSendAt: number | null = null
  private lastErrorAt: number | null = null
  private latencies: number[] = []

  // Circuit breaker (simple)
  private circuitState: 'CLOSED' | 'OPEN' | 'HALF_OPEN' = 'CLOSED'
  private consecutiveFailures: number = 0
  private circuitOpenUntil: number = 0
  private static readonly CIRCUIT_FAILURE_THRESHOLD = 5
  private static readonly CIRCUIT_RESET_MS = 30_000

  // State
  private inFlight: number = 0
  private destroyed: boolean = false
  private sending: boolean = false

  constructor(
    route: TransportRouteName,
    endpointConfig: TransportEndpointConfig,
    sharedConfig: TransportSharedConfig,
    apiKey: string
  ) {
    this.route = route
    this.endpointConfig = { ...endpointConfig }
    this.sharedConfig = sharedConfig
    this.apiKey = apiKey
  }

  /** Start the flush timer. */
  start(): void {
    if (this.flushTimer || this.destroyed) return

    if (this.endpointConfig.flushIntervalMs > 0) {
      this.flushTimer = setInterval(() => {
        void this.flush()
      }, this.endpointConfig.flushIntervalMs)

      if (this.flushTimer && typeof this.flushTimer === 'object' && 'unref' in this.flushTimer) {
        ;(this.flushTimer as NodeJS.Timeout).unref()
      }
    }
  }

  /** Enqueue an event for batched sending. */
  enqueue(event: SDKEvent): void {
    if (this.destroyed) return

    this.buffer.push(event)

    // If buffer hits batch size, flush immediately
    if (this.buffer.length >= this.endpointConfig.batchSize) {
      void this.flush()
    }
  }

  /** Flush the current buffer to the send queue. */
  async flush(): Promise<void> {
    if (this.destroyed || this.buffer.length === 0) return

    const batch = this.buffer.splice(0, this.endpointConfig.batchSize)
    if (batch.length === 0) return

    // Check queue size limit
    if (this.queue.length >= this.sharedConfig.queue.maxSize) {
      if (this.sharedConfig.queue.overflowStrategy === 'drop_oldest') {
        const dropped = this.queue.shift()
        if (dropped) this.totalDropped += dropped.length
      }
    }

    this.queue.push(batch)
    await this.processQueue()
  }

  /** Process queued batches. */
  private async processQueue(): Promise<void> {
    if (this.sending || this.destroyed) return

    this.sending = true

    try {
      while (this.queue.length > 0 && !this.destroyed) {
        // Circuit breaker check
        if (this.circuitState === 'OPEN') {
          if (Date.now() < this.circuitOpenUntil) break
          this.circuitState = 'HALF_OPEN'
        }

        const batch = this.queue[0]!
        const success = await this.sendBatch(batch)

        if (success) {
          this.queue.shift()
          this.totalSent += batch.length
          this.lastSendAt = Date.now()
          this.consecutiveFailures = 0
          if (this.circuitState === 'HALF_OPEN') {
            this.circuitState = 'CLOSED'
          }
        } else {
          this.totalFailed += batch.length
          this.lastErrorAt = Date.now()
          this.consecutiveFailures++

          if (this.consecutiveFailures >= RouteTransportManager.CIRCUIT_FAILURE_THRESHOLD) {
            this.circuitState = 'OPEN'
            this.circuitOpenUntil = Date.now() + RouteTransportManager.CIRCUIT_RESET_MS
            getLogger().warn(`[Route:${this.route}] Circuit OPEN — pausing sends for 30s`)
          }

          break // Stop processing on failure
        }
      }
    } finally {
      this.sending = false
    }
  }

  /** Send a batch to the endpoint with retry logic. */
  private async sendBatch(batch: SDKEvent[]): Promise<boolean> {
    const maxRetries = this.sharedConfig.retry.enabled ? this.sharedConfig.retry.maxRetries : 0

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        this.inFlight++
        const startTime = Date.now()

        const payload = JSON.stringify({
          events: batch,
          route: this.route,
          timestamp: Date.now(),
        })

        // Compression
        let body: BodyInit = payload
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
          'X-Route': this.route,
        }

        if (this.endpointConfig.compression === 'gzip') {
          try {
            const zlib = await import('node:zlib')
            const compressed = await new Promise<Buffer>((resolve, reject) => {
              zlib.gzip(Buffer.from(payload), (err, result) => {
                if (err) reject(err)
                else resolve(result)
              })
            })
            body = new Blob([compressed.buffer.slice(compressed.byteOffset, compressed.byteOffset + compressed.byteLength) as ArrayBuffer])
            headers['Content-Encoding'] = 'gzip'
          } catch {
            // Fall back to uncompressed
          }
        }

        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), this.endpointConfig.timeoutMs)

        try {
          const response = await fetch(this.endpointConfig.url, {
            method: 'POST',
            headers,
            body: body,
            signal: controller.signal,
          })

          clearTimeout(timeout)
          const latency = Date.now() - startTime
          this.trackLatency(latency)

          if (response.ok) {
            return true
          }

          // Rate limit — 429
          if (response.status === 429) {
            const retryAfter = response.headers.get('Retry-After')
            const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : this.getBackoffMs(attempt)
            getLogger().warn(`[Route:${this.route}] Rate limited (429), retrying in ${waitMs}ms`)
            await this.sleep(waitMs)
            continue
          }

          // Server errors — retry
          if (response.status >= 500) {
            const waitMs = this.getBackoffMs(attempt)
            getLogger().warn(`[Route:${this.route}] Server error ${response.status}, retry ${attempt + 1}/${maxRetries}`)
            await this.sleep(waitMs)
            this.totalRetries++
            continue
          }

          // Client errors — don't retry
          getLogger().error(`[Route:${this.route}] Client error ${response.status}, dropping batch`)
          return false
        } finally {
          clearTimeout(timeout)
        }
      } catch (err) {
        if (attempt < maxRetries) {
          const waitMs = this.getBackoffMs(attempt)
          getLogger().warn(
            `[Route:${this.route}] Send error: ${err instanceof Error ? err.message : String(err)}, retry ${attempt + 1}/${maxRetries}`
          )
          await this.sleep(waitMs)
          this.totalRetries++
          continue
        }
        return false
      } finally {
        this.inFlight--
      }
    }

    return false
  }

  /** Update endpoint config on config change. */
  updateConfig(endpointConfig: TransportEndpointConfig, sharedConfig: TransportSharedConfig): void {
    const oldFlushInterval = this.endpointConfig.flushIntervalMs
    this.endpointConfig = { ...endpointConfig }
    this.sharedConfig = sharedConfig

    // Restart flush timer if interval changed
    if (oldFlushInterval !== endpointConfig.flushIntervalMs) {
      this.stopFlushTimer()
      this.start()
    }
  }

  /** Get route health status. */
  getHealth(): RouteTransportHealth {
    return {
      route: this.route,
      url: this.endpointConfig.url,
      priority: this.endpointConfig.priority,
      queueSize: this.queue.length + (this.buffer.length > 0 ? 1 : 0),
      queueCapacity: this.sharedConfig.queue.maxSize,
      inFlightCount: this.inFlight,
      totalSent: this.totalSent,
      totalFailed: this.totalFailed,
      totalDropped: this.totalDropped,
      totalRetries: this.totalRetries,
      circuitState: this.circuitState,
      lastSendAt: this.lastSendAt,
      lastErrorAt: this.lastErrorAt,
      avgLatencyMs: this.latencies.length > 0
        ? this.latencies.reduce((a, b) => a + b, 0) / this.latencies.length
        : 0,
    }
  }

  /** Flush all pending events and stop. */
  async shutdown(): Promise<void> {
    this.destroyed = true
    this.stopFlushTimer()

    // Final flush
    if (this.buffer.length > 0) {
      const batch = this.buffer.splice(0)
      this.queue.push(batch)
    }

    // Send remaining queued batches
    while (this.queue.length > 0) {
      const batch = this.queue.shift()!
      await this.sendBatch(batch)
    }
  }

  // ─── Private Helpers ──────────────────────────────────────────────────────

  private stopFlushTimer(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer)
      this.flushTimer = null
    }
  }

  private getBackoffMs(attempt: number): number {
    return this.sharedConfig.retry.baseDelayMs * Math.pow(2, attempt)
  }

  private trackLatency(latencyMs: number): void {
    this.latencies.push(latencyMs)
    if (this.latencies.length > 100) {
      this.latencies.shift()
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
  }
}
