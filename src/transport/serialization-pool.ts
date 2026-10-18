import { Worker } from 'worker_threads'
import { getLogger } from '../utils/logger.js'
import { type CompressionAlgorithm, compressGzip, compressBrotli } from '../utils/compression.js'
import { SecurityScrubber } from '../processors/security-scrubber.js'
import { sanitizeEvent } from '../processors/sanitizer.js'
import type { PrivacyConfig } from '../types/config.js'
import type { SDKEvent } from '../types/event.js'
import { safeJsonStringify } from '../utils/safe-json.js'

export interface SerializeBatchOptions {
  readonly events: readonly unknown[]
  readonly route?: string | undefined
  readonly timestamp?: number | undefined
  readonly privacyConfig?: PrivacyConfig | undefined
  readonly compression: CompressionAlgorithm
  readonly maxPayloadBytes?: number | undefined
}

export interface SerializeBatchResult {
  readonly buffer: Buffer
  readonly algorithm: CompressionAlgorithm
  readonly originalSize: number
  readonly compressedSize: number
  readonly tooLarge?: boolean
}

const MAX_PENDING_REQUESTS = 64

interface WorkerEntry {
  worker: Worker
  onlinePromise: Promise<void>
}

export class SerializationPool {
  private workers: Worker[] = []
  private workerEntries: WorkerEntry[] = []
  private readyWorkers = new Set<Worker>()
  private roundRobinIndex = 0
  private pendingRequests = new Map<
    number,
    { worker: Worker; resolve: (val: any) => void; reject: (err: any) => void; timer: NodeJS.Timeout }
  >()
  private destroyed = false
  private static instance: SerializationPool | null = null
  private nextId = 0
  private started = false

  constructor(private readonly poolSize = 1) {}

  public static readonly WORKER_OFFLOAD_THRESHOLD_BYTES = 50 * 1024 // 50KB

  private static isLargeBatch(events: readonly unknown[]): boolean {
    if (events.length >= 250) return true
    let estimatedBytes = 0
    for (let i = 0; i < events.length; i++) {
      const ev = events[i] as Record<string, unknown> | string | null | undefined
      if (!ev) continue
      if (typeof ev === 'string') {
        estimatedBytes += ev.length
      } else if (typeof ev === 'object') {
        const type = ev['type']
        if (type === 'profile') return true
        if (type === 'trace') {
          const spanCount = typeof ev['spanCount'] === 'number' ? ev['spanCount'] : 20
          estimatedBytes += spanCount * 600
        }
        if (typeof ev['message'] === 'string') estimatedBytes += ev['message'].length
        if (typeof ev['data'] === 'string') estimatedBytes += ev['data'].length
        if (typeof ev['bodySize'] === 'number') estimatedBytes += Math.min(ev['bodySize'], 65_536)
        if (Array.isArray(ev['stack'])) estimatedBytes += ev['stack'].length * 250
        if (Array.isArray(ev['breadcrumbs'])) estimatedBytes += ev['breadcrumbs'].length * 180
        if (Array.isArray(ev['events'])) estimatedBytes += ev['events'].length * 200
        if (typeof ev['stack'] === 'string') estimatedBytes += ev['stack'].length
        if (typeof ev['body'] === 'string') estimatedBytes += ev['body'].length
        if (typeof ev['payload'] === 'string') estimatedBytes += ev['payload'].length
        estimatedBytes += 350
      }
      if (estimatedBytes >= SerializationPool.WORKER_OFFLOAD_THRESHOLD_BYTES) {
        return true
      }
    }
    return false
  }

  private startWorkers(): void {
    if (this.started || this.destroyed || this.poolSize <= 0) return
    this.started = true
    try {
      const workerUrl = new URL('./serialization-worker.js', import.meta.url)
      for (let i = 0; i < this.poolSize; i++) {
        this.addWorker(workerUrl)
      }
    } catch (err) {
      getLogger().warn('Failed to initialize worker pool, falling back to main thread', { error: err })
    }
  }

  private addWorker(workerUrl: URL) {
    const worker = new Worker(workerUrl)
    worker.unref?.()
    const onlinePromise = new Promise<void>((resolve) => {
      worker.once('online', () => {
        if (!this.destroyed && this.workers.includes(worker)) this.readyWorkers.add(worker)
        resolve()
      })
      worker.once('error', () => resolve())
      worker.once('exit', () => resolve())
    })
    this.workerEntries.push({ worker, onlinePromise })
    worker.on('message', (msg) => {
      const req = this.pendingRequests.get(msg.id)
      if (req) {
        clearTimeout(req.timer)
        this.pendingRequests.delete(msg.id)
        if (msg.error) {
          req.reject(new Error(msg.error))
        } else if (msg.tooLarge) {
          req.resolve({
            buffer: Buffer.alloc(0),
            algorithm: 'none',
            originalSize: msg.originalSize ?? 0,
            compressedSize: 0,
            tooLarge: true,
          })
        } else {
          req.resolve({
            buffer: Buffer.isBuffer(msg.buffer) ? msg.buffer : Buffer.from(msg.buffer),
            algorithm: msg.algorithm,
            originalSize: msg.originalSize,
            compressedSize: msg.compressedSize,
            tooLarge: false,
          })
        }
      }
    })
    worker.on('error', (err) => {
      getLogger().error('Serialization worker error', { error: err })
      this.handleWorkerCrash(worker)
    })
    worker.on('exit', (code) => {
      this.handleWorkerCrash(worker)
      if (code !== 0 && !this.destroyed) {
        getLogger().error('Serialization worker exited unexpectedly', { code })
      }
    })
    this.workers.push(worker)
  }

  private handleWorkerCrash(worker: Worker) {
    this.workers = this.workers.filter(w => w !== worker)
    this.workerEntries = this.workerEntries.filter(e => e.worker !== worker)
    this.readyWorkers.delete(worker)
    this.roundRobinIndex = 0

    for (const [id, req] of this.pendingRequests.entries()) {
      if (req.worker === worker) {
        clearTimeout(req.timer)
        this.pendingRequests.delete(id)
        req.reject(new Error('Serialization worker crashed'))
      }
    }
  }

  static initialize(poolSize = 1) {
    if (!SerializationPool.instance) {
      SerializationPool.instance = new SerializationPool(poolSize)
    }
  }

  static getInstance(): SerializationPool | null {
    return SerializationPool.instance
  }

  async serialize(
    events: unknown,
    compression: CompressionAlgorithm,
  ): Promise<{ buffer: Buffer; algorithm: CompressionAlgorithm; originalSize: number; compressedSize: number }> {
    const res = await this.serializeBatch({
      events: Array.isArray(events) ? events : [events],
      compression,
    })
    return {
      buffer: res.buffer,
      algorithm: res.algorithm,
      originalSize: res.originalSize,
      compressedSize: res.compressedSize,
    }
  }

  async serializeBatch(options: SerializeBatchOptions): Promise<SerializeBatchResult> {
    if (this.destroyed) {
      return this.fallbackSerializeBatch(options)
    }

    const isLarge = SerializationPool.isLargeBatch(options.events)

    // Lazy initialization: Spawn worker threads ONLY when payload exceeds the offload
    // threshold (e.g. >= 50KB or large batches).
    // Small batches process in < 0.1ms on the main thread via libuv without inter-thread
    // structured cloning overhead, avoiding 70MB-90MB of baseline RSS.
    if (isLarge && !this.started && this.poolSize > 0) {
      this.startWorkers()
    }

    // If workers were just launched, give them up to 150ms to become ready before falling back
    if (isLarge && this.readyWorkers.size === 0 && this.workerEntries.length > 0) {
      await Promise.race([
        Promise.all(this.workerEntries.map(e => e.onlinePromise)),
        new Promise(r => setTimeout(r, 150)),
      ])
    }

    const ready = [...this.readyWorkers]
    if (ready.length === 0 || !isLarge || this.destroyed || this.pendingRequests.size >= MAX_PENDING_REQUESTS) {
      return this.fallbackSerializeBatch(options)
    }

    const worker = ready[this.roundRobinIndex % ready.length]!
    this.roundRobinIndex = (this.roundRobinIndex + 1) % ready.length

    const id = this.nextId++
    return new Promise<SerializeBatchResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id)
        reject(new Error('Serialization worker timeout'))
      }, 5000)

      this.pendingRequests.set(id, { worker, resolve, reject, timer })
      try {
        worker.postMessage({
          id,
          events: options.events,
          route: options.route,
          timestamp: options.timestamp,
          privacyConfig: options.privacyConfig,
          compression: options.compression,
          maxPayloadBytes: options.maxPayloadBytes,
        })
      } catch (postErr) {
        clearTimeout(timer)
        this.pendingRequests.delete(id)
        reject(postErr)
      }
    }).catch((err) => {
      getLogger().debug('Worker serialization failed, falling back to main thread', { error: err })
      return this.fallbackSerializeBatch(options)
    })
  }

  private async fallbackSerializeBatch(options: SerializeBatchOptions): Promise<SerializeBatchResult> {
    const { events, route, timestamp, privacyConfig, compression, maxPayloadBytes } = options
    let safeEvents = events
    if (Array.isArray(events)) {
      const scrubber = SecurityScrubber.getInstance() ?? (privacyConfig ? SecurityScrubber.initialize(privacyConfig) : null)
      if (scrubber) {
        safeEvents = scrubber.scrubBatch(events as SDKEvent[])
      } else {
        safeEvents = (events as SDKEvent[]).map(e => sanitizeEvent(e))
      }
    }
    const payload = route
      ? { events: safeEvents, route, timestamp: timestamp ?? Date.now() }
      : safeEvents
    const jsonStr = safeJsonStringify(payload)
    const buf = Buffer.from(jsonStr, 'utf8')
    const originalSize = buf.byteLength

    if (typeof maxPayloadBytes === 'number' && maxPayloadBytes > 0 && originalSize > maxPayloadBytes) {
      return {
        buffer: Buffer.alloc(0),
        algorithm: 'none',
        originalSize,
        compressedSize: 0,
        tooLarge: true,
      }
    }

    let compressedBuf: Buffer = buf
    let algorithm = compression
    if (compression === 'gzip') {
      compressedBuf = Buffer.from(await compressGzip(buf))
    } else if (compression === 'brotli') {
      compressedBuf = Buffer.from(await compressBrotli(buf))
    } else {
      algorithm = 'none'
    }

    return {
      buffer: compressedBuf,
      algorithm,
      originalSize,
      compressedSize: compressedBuf.byteLength,
      tooLarge: false,
    }
  }

  async shutdown(): Promise<void> {
    if (!this.started && this.workers.length === 0) {
      this.destroyed = true
      return
    }

    this.destroyed = true
    this.started = false

    if (this.pendingRequests.size > 0) {
      const deadline = Date.now() + 500
      while (this.pendingRequests.size > 0 && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 10))
      }
    }

    for (const req of this.pendingRequests.values()) {
      clearTimeout(req.timer)
      req.reject(new Error('Pool shutting down'))
    }
    this.pendingRequests.clear()

    await Promise.all(
      this.workerEntries.map(e =>
        Promise.race([e.onlinePromise, new Promise(r => setTimeout(r, 500))])
      )
    )

    const hadWorkers = this.workers.length > 0
    await Promise.all(
      this.workers.map(async w => {
        try {
          await w.terminate()
        } catch {}
      })
    )
    this.workers = []
    this.workerEntries = []
    this.readyWorkers.clear()
    // Allow libuv to process handle close callbacks (uv_process_endgames) on Windows
    if (hadWorkers) {
      await new Promise(r => setTimeout(r, 25))
    }
  }

  static async reset(): Promise<void> {
    if (SerializationPool.instance) {
      await SerializationPool.instance.shutdown()
      SerializationPool.instance = null
    }
  }
}
