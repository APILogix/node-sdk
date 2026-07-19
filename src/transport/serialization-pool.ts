import { Worker } from 'worker_threads'
import { getLogger } from '../utils/logger.js'
import type { CompressionAlgorithm } from '../utils/compression.js'
import { compress } from '../utils/compression.js'

export class SerializationPool {
  private workers: Worker[] = []
  private roundRobinIndex = 0
  private pendingRequests = new Map<number, { resolve: (val: any) => void, reject: (err: any) => void, timer: NodeJS.Timeout }>()
  private destroyed = false
  private static instance: SerializationPool | null = null
  private nextId = 0

  constructor(poolSize = 2) {
    try {
      const workerUrl = new URL('./serialization-worker.js', import.meta.url)
      for (let i = 0; i < poolSize; i++) {
        this.addWorker(workerUrl)
      }
    } catch (err) {
      getLogger().warn('Failed to initialize worker pool, falling back to main thread', { error: err })
    }
  }

  private addWorker(workerUrl: URL) {
    const worker = new Worker(workerUrl)
    worker.on('message', (msg) => {
      const req = this.pendingRequests.get(msg.id)
      if (req) {
        clearTimeout(req.timer)
        this.pendingRequests.delete(msg.id)
        if (msg.error) req.reject(new Error(msg.error))
        else req.resolve({ buffer: msg.buffer, algorithm: msg.algorithm, originalSize: msg.originalSize, compressedSize: msg.compressedSize })
      }
    })
    worker.on('error', (err) => {
      getLogger().error('Serialization worker error', { error: err })
      this.handleWorkerCrash(worker, workerUrl)
    })
    worker.on('exit', (code) => {
      if (code !== 0 && !this.destroyed) {
        getLogger().error('Serialization worker exited unexpectedly', { code })
        this.handleWorkerCrash(worker, workerUrl)
      }
    })
    this.workers.push(worker)
  }

  private handleWorkerCrash(worker: Worker, workerUrl: URL) {
    this.workers = this.workers.filter(w => w !== worker)
    if (!this.destroyed) {
      setTimeout(() => this.addWorker(workerUrl), 1000)
    }
  }

  static initialize(poolSize = 2) {
    if (!SerializationPool.instance) {
      SerializationPool.instance = new SerializationPool(poolSize)
    }
  }

  static getInstance(): SerializationPool | null {
    return SerializationPool.instance
  }

  async serialize(events: unknown[], compression: CompressionAlgorithm): Promise<{ buffer: Buffer, algorithm: CompressionAlgorithm, originalSize: number, compressedSize: number }> {
    if (this.workers.length === 0 || this.destroyed) {
      return this.fallbackSerialize(events, compression)
    }

    const worker = this.workers[this.roundRobinIndex]!
    this.roundRobinIndex = (this.roundRobinIndex + 1) % this.workers.length

    const id = this.nextId++
    return new Promise<{ buffer: Buffer, algorithm: CompressionAlgorithm, originalSize: number, compressedSize: number }>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id)
        reject(new Error('Serialization worker timeout'))
      }, 5000)

      this.pendingRequests.set(id, { resolve, reject, timer })
      worker.postMessage({ id, events, compression })
    }).catch((err) => {
      getLogger().warn('Worker serialization failed, falling back to main thread', { error: err })
      return this.fallbackSerialize(events, compression)
    })
  }

  private async fallbackSerialize(events: unknown[], compression: CompressionAlgorithm) {
    const jsonStr = JSON.stringify(events)
    const buf = Buffer.from(jsonStr)
    const result = await compress(buf, compression)
    return { buffer: Buffer.from(result.buffer), algorithm: result.algorithm, originalSize: result.originalSize, compressedSize: result.compressedSize }
  }

  async shutdown() {
    this.destroyed = true
    for (const req of this.pendingRequests.values()) {
      clearTimeout(req.timer)
      req.reject(new Error('Pool shutting down'))
    }
    this.pendingRequests.clear()
    await Promise.all(this.workers.map(w => w.terminate()))
    this.workers = []
  }

  /**
   * Terminate the worker pool and clear the singleton. Awaits worker
   * termination so a shutdown/reinit cycle never leaks worker threads —
   * the previous fire-and-forget `void shutdown()` let workers outlive
   * the SDK and kept the host process alive.
   */
  static async reset(): Promise<void> {
    if (SerializationPool.instance) {
      await SerializationPool.instance.shutdown()
      SerializationPool.instance = null
    }
  }
}
