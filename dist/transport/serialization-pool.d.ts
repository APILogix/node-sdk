import type { CompressionAlgorithm } from '../utils/compression.js';
export declare class SerializationPool {
    private workers;
    private roundRobinIndex;
    private pendingRequests;
    private destroyed;
    private static instance;
    private nextId;
    constructor(poolSize?: number);
    private addWorker;
    private handleWorkerCrash;
    static initialize(poolSize?: number): void;
    static getInstance(): SerializationPool | null;
    serialize(events: unknown[], compression: CompressionAlgorithm): Promise<{
        buffer: Buffer;
        algorithm: CompressionAlgorithm;
        originalSize: number;
        compressedSize: number;
    }>;
    private fallbackSerialize;
    shutdown(): Promise<void>;
    static reset(): void;
}
//# sourceMappingURL=serialization-pool.d.ts.map