/**
 * LoggingSubsystem — captures console.log/warn/error/info and explicit log calls.
 *
 * Behavior:
 * - Intercepts console methods based on logging.captureConsole config.
 * - Only captures configured log levels (logging.levels array).
 * - Truncates messages to logging.maxLogSize bytes.
 * - Routes LogEvent objects to the transport layer via the provided emit callback.
 * - Respects killswitch: disableLogs → detach interceptors, drain buffer.
 * - Restores original console methods on teardown.
 */
import type { LoggingConfig, ConfigDiff, RemoteConfigResponse } from '../types/config.js';
import type { LogEvent, EventMetadata } from '../types/event.js';
type LogEmitter = (event: LogEvent) => void;
export declare class LoggingSubsystem {
    private static instance;
    private config;
    private emitter;
    private metadata;
    /** Stashed original console methods — restored on teardown. */
    private originals;
    private wrappers;
    private intercepted;
    private destroyed;
    private constructor();
    static initialize(config: LoggingConfig, emitter: LogEmitter, metadata: EventMetadata): LoggingSubsystem;
    static getInstance(): LoggingSubsystem | null;
    /** Start intercepting console methods. */
    start(): void;
    /** Stop intercepting and restore original console methods. */
    stop(): void;
    /** Explicitly capture a log event. */
    captureLog(level: string, message: string, args?: readonly unknown[]): void;
    /**
     * Handle config change — hot-swap logging config.
     *
     * The wire schema no longer contains a `logging` block; init wires a
     * synthesized config (SDK defaults + `features.logging` mirror) onto
     * the config object passed here. We cast through `unknown` because the
     * public `RemoteConfigResponse` type intentionally doesn't expose this
     * legacy shape.
     */
    handleConfigChange(_diff: ConfigDiff, newConfig: Readonly<RemoteConfigResponse>): void;
    private isLevelAllowed;
    private truncateMessage;
    private installInterceptors;
    private removeInterceptors;
    destroy(): void;
    static reset(): void;
}
export {};
//# sourceMappingURL=logging-subsystem.d.ts.map