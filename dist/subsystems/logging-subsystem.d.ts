/**
 * Structured logging subsystem. Remote config owns whether logging exists;
 * local constants define implementation-only console and size behavior.
 */
import type { RemoteConfigResponse } from '../types/config.js';
import type { LogEvent, EventMetadata } from '../types/event.js';
type LogEmitter = (event: LogEvent) => void;
export declare class LoggingSubsystem {
    private static instance;
    private static captureReentry;
    private config;
    private readonly emitter;
    private metadata;
    private readonly originals;
    private readonly wrappers;
    private intercepted;
    private destroyed;
    private constructor();
    static initialize(config: Readonly<RemoteConfigResponse>, emitter: LogEmitter, metadata: EventMetadata): LoggingSubsystem;
    static getInstance(): LoggingSubsystem | null;
    updateMetadata(metadata: EventMetadata): void;
    start(): void;
    stop(): void;
    captureLog(level: string, message: string, args?: readonly unknown[]): void;
    /** Apply a validated complete snapshot selected by ConfigManager. */
    handleConfigChange(config: Readonly<RemoteConfigResponse>): void;
    private scrubLogArgs;
    private isLevelAllowed;
    private truncateMessage;
    private installInterceptors;
    private removeInterceptors;
    destroy(): void;
    static reset(): void;
}
export {};
