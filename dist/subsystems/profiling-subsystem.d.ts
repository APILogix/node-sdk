/** CPU and Heap profiling subsystem driven by the authoritative remote snapshot. */
import type { RemoteConfigResponse } from '../types/config.js';
import type { ProfileEvent, EventMetadata } from '../types/event.js';
type ProfileEmitter = (event: ProfileEvent) => void;
export declare class ProfilingSubsystem {
    private static instance;
    private config;
    private readonly emitter;
    private metadata;
    private readonly activeProfiles;
    private activeCpuProfileKey;
    private activeHeapProfileKey;
    private inspectorSession;
    private inspectorAvailable;
    private destroyed;
    private continuousTimer;
    private coolingTimer;
    private continuousChunkStartTime;
    private isContinuousRunning;
    private isCooling;
    private readonly activeTracesInChunk;
    private constructor();
    static initialize(config: Readonly<RemoteConfigResponse>, emitter: ProfileEmitter, metadata: EventMetadata): ProfilingSubsystem;
    static getInstance(): ProfilingSubsystem | null;
    updateMetadata(metadata: EventMetadata): void;
    start(): Promise<void>;
    /**
     * Starts continuous wall-clock CPU sampling driven by remote config.
     * Periodically flushes chunked profiles to the backend ingestion queue.
     */
    startContinuousProfiling(): Promise<boolean>;
    private scheduleNextContinuousChunk;
    /**
     * Stops the current continuous profiling chunk, emits the profile event,
     * and restarts the next chunk after any enforced cooling interval.
     */
    flushContinuousChunk(): Promise<void>;
    /**
     * Stops the continuous profiling loop and shuts down the V8 profiler.
     */
    stopContinuousProfiling(): Promise<void>;
    /**
     * Correlates an active traceId with the current continuous profiling chunk.
     */
    recordActiveTrace(traceId: string): void;
    /**
     * Returns whether continuous wall-clock profiling is currently running.
     */
    isContinuousActive(): boolean;
    /**
     * Returns whether continuous profiling is currently in a cooling-off interval.
     */
    isContinuousCooling(): boolean;
    /**
     * Returns current continuous profiling configuration.
     */
    getContinuousConfig(): {
        continuous: boolean;
        intervalMs: number;
        sampleRateHz: number;
        coolingIntervalMs: number;
    };
    startCpuProfile(traceId?: string, spanId?: string): Promise<boolean>;
    stopCpuProfile(traceId: string): Promise<void>;
    /**
     * Starts a heap allocation profile using the V8 SamplingHeapProfiler.
     */
    startHeapProfile(traceId?: string, spanId?: string): Promise<boolean>;
    /**
     * Stops a heap allocation profile and emits the profile event.
     */
    stopHeapProfile(traceId: string): Promise<void>;
    /** Apply a validated complete snapshot selected by ConfigManager. */
    handleConfigChange(config: Readonly<RemoteConfigResponse>): void;
    stop(): Promise<void>;
    private canProfile;
    private shouldProfile;
    destroy(): void;
    static reset(): void;
}
export {};
