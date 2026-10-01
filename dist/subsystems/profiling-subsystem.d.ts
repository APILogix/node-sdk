/** CPU profiling subsystem driven by the authoritative remote snapshot. */
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
    private inspectorSession;
    private inspectorAvailable;
    private destroyed;
    private continuousTimer;
    private continuousChunkStartTime;
    private isContinuousRunning;
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
    /**
     * Stops the current continuous profiling chunk, emits the profile event,
     * and immediately restarts the next chunk.
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
     * Returns current continuous profiling configuration.
     */
    getContinuousConfig(): {
        continuous: boolean;
        intervalMs: number;
        sampleRateHz: number;
    };
    startCpuProfile(traceId?: string, spanId?: string): Promise<boolean>;
    stopCpuProfile(traceId: string): Promise<void>;
    /** Apply a validated complete snapshot selected by ConfigManager. */
    handleConfigChange(config: Readonly<RemoteConfigResponse>): void;
    stop(): Promise<void>;
    private canProfile;
    private shouldProfile;
    destroy(): void;
    static reset(): void;
}
export {};
