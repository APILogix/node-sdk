import type { CompressionAlgorithm } from '../utils/compression.js';
export declare class SerializationPool {
    private readonly poolSize;
    private workers;
    private readyWorkers;
    private roundRobinIndex;
    private pendingRequests;
    private destroyed;
    private static instance;
    private nextId;
    private started;
    constructor(poolSize?: number);
    private startWorkers;
    private addWorker;
    private handleWorkerCrash;
    static initialize(poolSize?: number): void;
    static getInstance(): SerializationPool | null;
    serialize(events: unknown, compression: CompressionAlgorithm): Promise<{
        buffer: Buffer;
        algorithm: CompressionAlgorithm;
        originalSize: number;
        compressedSize: number;
    }>;
    private fallbackSerialize;
    shutdown(): Promise<void>;
    /**
     * Terminate the worker pool and clear the singleton. Awaits worker
     * termination so a shutdown/reinit cycle never leaks worker threads —
     * the previous fire-and-forget `void shutdown()` let workers outlive
     * the SDK and kept the host process alive.
     */
    static reset(): Promise<void>;
}
