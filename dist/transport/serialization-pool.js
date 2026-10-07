import { Worker } from 'worker_threads';
import { getLogger } from '../utils/logger.js';
import { compressGzip, compressBrotli } from '../utils/compression.js';
import { SecurityScrubber } from '../processors/security-scrubber.js';
import { safeJsonStringify } from '../utils/safe-json.js';
const MAX_PENDING_REQUESTS = 64;
export class SerializationPool {
    poolSize;
    workers = [];
    workerEntries = [];
    readyWorkers = new Set();
    roundRobinIndex = 0;
    pendingRequests = new Map();
    destroyed = false;
    static instance = null;
    nextId = 0;
    started = false;
    constructor(poolSize = 2) {
        this.poolSize = poolSize;
    }
    startWorkers() {
        if (this.started || this.destroyed)
            return;
        this.started = true;
        try {
            const workerUrl = new URL('./serialization-worker.js', import.meta.url);
            for (let i = 0; i < this.poolSize; i++) {
                this.addWorker(workerUrl);
            }
        }
        catch (err) {
            getLogger().warn('Failed to initialize worker pool, falling back to main thread', { error: err });
        }
    }
    addWorker(workerUrl) {
        const worker = new Worker(workerUrl);
        const onlinePromise = new Promise((resolve) => {
            worker.once('online', () => {
                if (!this.destroyed && this.workers.includes(worker))
                    this.readyWorkers.add(worker);
                resolve();
            });
            worker.once('error', () => resolve());
            worker.once('exit', () => resolve());
        });
        this.workerEntries.push({ worker, onlinePromise });
        worker.on('message', (msg) => {
            const req = this.pendingRequests.get(msg.id);
            if (req) {
                clearTimeout(req.timer);
                this.pendingRequests.delete(msg.id);
                if (msg.error) {
                    req.reject(new Error(msg.error));
                }
                else if (msg.tooLarge) {
                    req.resolve({
                        buffer: Buffer.alloc(0),
                        algorithm: 'none',
                        originalSize: msg.originalSize ?? 0,
                        compressedSize: 0,
                        tooLarge: true,
                    });
                }
                else {
                    req.resolve({
                        buffer: Buffer.isBuffer(msg.buffer) ? msg.buffer : Buffer.from(msg.buffer),
                        algorithm: msg.algorithm,
                        originalSize: msg.originalSize,
                        compressedSize: msg.compressedSize,
                        tooLarge: false,
                    });
                }
            }
        });
        worker.on('error', (err) => {
            getLogger().error('Serialization worker error', { error: err });
            this.handleWorkerCrash(worker);
        });
        worker.on('exit', (code) => {
            this.handleWorkerCrash(worker);
            if (code !== 0 && !this.destroyed) {
                getLogger().error('Serialization worker exited unexpectedly', { code });
            }
        });
        this.workers.push(worker);
    }
    handleWorkerCrash(worker) {
        this.workers = this.workers.filter(w => w !== worker);
        this.workerEntries = this.workerEntries.filter(e => e.worker !== worker);
        this.readyWorkers.delete(worker);
        this.roundRobinIndex = 0;
    }
    static initialize(poolSize = 2) {
        if (!SerializationPool.instance) {
            SerializationPool.instance = new SerializationPool(poolSize);
        }
    }
    static getInstance() {
        return SerializationPool.instance;
    }
    async serialize(events, compression) {
        const res = await this.serializeBatch({
            events: Array.isArray(events) ? events : [events],
            compression,
        });
        return {
            buffer: res.buffer,
            algorithm: res.algorithm,
            originalSize: res.originalSize,
            compressedSize: res.compressedSize,
        };
    }
    async serializeBatch(options) {
        this.startWorkers();
        const ready = [...this.readyWorkers];
        if (ready.length === 0 || this.destroyed || this.pendingRequests.size >= MAX_PENDING_REQUESTS) {
            return this.fallbackSerializeBatch(options);
        }
        const worker = ready[this.roundRobinIndex % ready.length];
        this.roundRobinIndex = (this.roundRobinIndex + 1) % ready.length;
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pendingRequests.delete(id);
                reject(new Error('Serialization worker timeout'));
            }, 5000);
            this.pendingRequests.set(id, { resolve, reject, timer });
            try {
                worker.postMessage({
                    id,
                    events: options.events,
                    route: options.route,
                    timestamp: options.timestamp,
                    privacyConfig: options.privacyConfig,
                    compression: options.compression,
                    maxPayloadBytes: options.maxPayloadBytes,
                });
            }
            catch (postErr) {
                clearTimeout(timer);
                this.pendingRequests.delete(id);
                reject(postErr);
            }
        }).catch((err) => {
            getLogger().debug('Worker serialization failed, falling back to main thread', { error: err });
            return this.fallbackSerializeBatch(options);
        });
    }
    async fallbackSerializeBatch(options) {
        const { events, route, timestamp, privacyConfig, compression, maxPayloadBytes } = options;
        let safeEvents = events;
        if (privacyConfig && Array.isArray(events)) {
            const scrubber = SecurityScrubber.getInstance() ?? SecurityScrubber.initialize(privacyConfig);
            safeEvents = scrubber.scrubBatch(events);
        }
        const payload = route
            ? { events: safeEvents, route, timestamp: timestamp ?? Date.now() }
            : safeEvents;
        const jsonStr = safeJsonStringify(payload);
        const buf = Buffer.from(jsonStr, 'utf8');
        const originalSize = buf.byteLength;
        if (typeof maxPayloadBytes === 'number' && maxPayloadBytes > 0 && originalSize > maxPayloadBytes) {
            return {
                buffer: Buffer.alloc(0),
                algorithm: 'none',
                originalSize,
                compressedSize: 0,
                tooLarge: true,
            };
        }
        let compressedBuf = buf;
        let algorithm = compression;
        if (compression === 'gzip') {
            compressedBuf = Buffer.from(await compressGzip(buf));
        }
        else if (compression === 'brotli') {
            compressedBuf = Buffer.from(await compressBrotli(buf));
        }
        else {
            algorithm = 'none';
        }
        return {
            buffer: compressedBuf,
            algorithm,
            originalSize,
            compressedSize: compressedBuf.byteLength,
            tooLarge: false,
        };
    }
    async shutdown() {
        this.destroyed = true;
        if (this.pendingRequests.size > 0) {
            const deadline = Date.now() + 500;
            while (this.pendingRequests.size > 0 && Date.now() < deadline) {
                await new Promise(r => setTimeout(r, 10));
            }
        }
        for (const req of this.pendingRequests.values()) {
            clearTimeout(req.timer);
            req.reject(new Error('Pool shutting down'));
        }
        this.pendingRequests.clear();
        await Promise.all(this.workerEntries.map(e => Promise.race([e.onlinePromise, new Promise(r => setTimeout(r, 500))])));
        await Promise.all(this.workers.map(async (w) => {
            try {
                await w.terminate();
            }
            catch { }
        }));
        this.workers = [];
        this.workerEntries = [];
        this.readyWorkers.clear();
        // Allow libuv to process handle close callbacks (uv_process_endgames) on Windows
        await new Promise(r => setTimeout(r, 25));
    }
    static async reset() {
        if (SerializationPool.instance) {
            await SerializationPool.instance.shutdown();
            SerializationPool.instance = null;
        }
    }
}
