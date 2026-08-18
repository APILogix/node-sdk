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
    private inspectorSession;
    private inspectorAvailable;
    private destroyed;
    private constructor();
    static initialize(config: Readonly<RemoteConfigResponse>, emitter: ProfileEmitter, metadata: EventMetadata): ProfilingSubsystem;
    static getInstance(): ProfilingSubsystem | null;
    updateMetadata(metadata: EventMetadata): void;
    start(): Promise<void>;
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
//# sourceMappingURL=profiling-subsystem.d.ts.map