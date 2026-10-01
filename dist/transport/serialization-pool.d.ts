import { type CompressionAlgorithm } from '../utils/compression.js';
import type { PrivacyConfig } from '../types/config.js';
export interface SerializeBatchOptions {
    readonly events: readonly unknown[];
    readonly route?: string | undefined;
    readonly timestamp?: number | undefined;
    readonly privacyConfig?: PrivacyConfig | undefined;
    readonly compression: CompressionAlgorithm;
    readonly maxPayloadBytes?: number | undefined;
}
export interface SerializeBatchResult {
    readonly buffer: Buffer;
    readonly algorithm: CompressionAlgorithm;
    readonly originalSize: number;
    readonly compressedSize: number;
    readonly tooLarge?: boolean;
}
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
    serializeBatch(options: SerializeBatchOptions): Promise<SerializeBatchResult>;
    private fallbackSerializeBatch;
    shutdown(): Promise<void>;
    static reset(): Promise<void>;
}
