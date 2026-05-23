/**
 * ProfilingSubsystem — CPU and heap profiling driven by remote config.
 *
 * Behavior:
 * - Only started when features.profiling = true AND profiling.enabled = true.
 * - CPU profiling: Uses Node.js inspector API to capture V8 CPU profiles.
 * - Heap profiling: Uses Node.js inspector API for heap snapshots.
 * - sampleRate: FNV-1a hash on traceId decides whether to profile a request.
 * - maxDurationMs: Hard cap on individual profile duration.
 * - Emits ProfileEvent objects to transport layer.
 * - Killswitch: disableProfiling → stop inspector, flush in-flight profiles.
 *
 * Note: The inspector API requires --inspect flag or explicit Session creation.
 * The subsystem gracefully degrades if inspector is not available.
 */
import type { ProfilingConfig, ConfigDiff, RemoteConfigResponse } from '../types/config.js';
import type { ProfileEvent, EventMetadata } from '../types/event.js';
type ProfileEmitter = (event: ProfileEvent) => void;
export declare class ProfilingSubsystem {
    private static instance;
    private config;
    private emitter;
    private metadata;
    private activeProfiles;
    private inspectorSession;
    private inspectorAvailable;
    private destroyed;
    private constructor();
    static initialize(config: ProfilingConfig, emitter: ProfileEmitter, metadata: EventMetadata): ProfilingSubsystem;
    static getInstance(): ProfilingSubsystem | null;
    /** Initialize the inspector session. */
    start(): Promise<void>;
    /**
     * Start a CPU profile for the given trace.
     * Call this at the beginning of a request if sampling decides to profile.
     */
    startCpuProfile(traceId: string, spanId?: string): Promise<boolean>;
    /**
     * Stop a CPU profile and emit the ProfileEvent.
     */
    stopCpuProfile(traceId: string): Promise<void>;
    /** Handle config change. */
    handleConfigChange(_diff: ConfigDiff, newConfig: Readonly<RemoteConfigResponse>): void;
    /** Stop all active profiles and disconnect inspector. */
    stop(): Promise<void>;
    private canProfile;
    destroy(): void;
    static reset(): void;
}
export {};
//# sourceMappingURL=profiling-subsystem.d.ts.map