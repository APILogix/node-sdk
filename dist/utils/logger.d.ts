/**
 * SDK Logger — Enterprise non-blocking, memory-bounded diagnostic logging.
 *
 * Output strategy (post v3 fix for the console-interception feedback loop):
 *   The SDK never writes through `console.log/info/warn/error`. Those
 *   slots are intercepted by `LoggingSubsystem.installInterceptors()` to
 *   capture user logs as `log` events; if the SDK itself wrote there,
 *   every internal `logger.debug/info/warn/error` call would create a
 *   `log` event, which inside the pipeline produces more debug output,
 *   producing more `log` events — a runaway storm we observed at
 *   thousands of events per second under `setDebugMode(true)`.
 *
 *   Both loggers below write directly to `process.stdout` (info /
 *   debug / trace) or `process.stderr` (warn / error / fatal) via a
 *   non-blocking, bounded stream writer. The LoggingSubsystem's
 *   wrapper never sees these writes, so the feedback loop is broken at
 *   the source.
 *
 *   Non-blocking & Low-Memory guarantees:
 *   - Direct fast path writes when stream is healthy.
 *   - Backpressure-aware drain queue bounded to 256 entries to prevent
 *     unbounded V8 heap expansion during slow I/O pipes.
 *   - Drops low-priority diagnostic logs under pipe backpressure.
 *   - PII redaction is always applied regardless of debug mode.
 */
import { type SeverityLevel } from '../types/severity.js';
export interface Logger {
    trace?(message: string, context?: Record<string, unknown>): void;
    debug(message: string, context?: Record<string, unknown>): void;
    info(message: string, context?: Record<string, unknown>): void;
    warn(message: string, context?: Record<string, unknown>): void;
    error(message: string, context?: Record<string, unknown>): void;
    fatal?(message: string, context?: Record<string, unknown>): void;
}
/**
 * Enable or disable debug logging globally.
 * Called during SDK initialization based on `options.debug`.
 */
export declare function setDebugMode(enabled: boolean): void;
/**
 * Get whether debug mode is currently enabled.
 */
export declare function isDebugMode(): boolean;
/**
 * Set the minimum SDK internal log level.
 */
export declare function setLogLevel(level: SeverityLevel): void;
/**
 * Get the current minimum log level.
 */
export declare function getLogLevel(): SeverityLevel;
/**
 * Set the log prefix (defaults to 'Telemetry').
 */
export declare function setLogPrefix(prefix: string): void;
/**
 * Get the current log prefix.
 */
export declare function getLogPrefix(): string;
/**
 * Non-blocking, bounded stream drainer.
 * Prevents V8 heap memory explosion and event-loop stalls when process.stdout
 * or process.stderr is backpressured (e.g. slow pipe consumer in Docker/K8s).
 */
export declare class NonBlockingStreamWriter {
    private readonly getStream;
    private readonly maxBufferSize;
    private buffer;
    private isDraining;
    private droppedCount;
    constructor(getStream: () => NodeJS.WriteStream, maxBufferSize?: number);
    write(line: string, isCritical?: boolean): void;
    private startDraining;
    private drainChunk;
    flushSync(): void;
    getDroppedCount(): number;
    getBufferSize(): number;
    reset(): void;
}
export declare const stdoutDrainer: NonBlockingStreamWriter;
export declare const stderrDrainer: NonBlockingStreamWriter;
export declare function getLoggerWriterStats(): {
    stdoutDrops: number;
    stderrDrops: number;
};
export declare function redact(value: unknown, depth?: number, seen?: WeakSet<object>): unknown;
export declare const consoleLogger: Logger;
/**
 * Structured JSON logger — emits newline-delimited JSON (NDJSON) suitable
 * for production log aggregation systems (ELK, Datadog, CloudWatch, etc.).
 *
 * Every log entry includes:
 * - ISO timestamp + timestamp_ms
 * - Log level & OpenTelemetry severity number
 * - Message
 * - Active traceId/spanId (if OTel tracing is active)
 * - SDK prefix tag
 * - Redacted structured context
 */
export declare const jsonLogger: Logger;
export type LogFormat = 'text' | 'json';
/**
 * Set the log output format.
 * 'text' = Sentry-style prefixed console output (default, good for dev)
 * 'json' = NDJSON structured output (production, log aggregation)
 */
export declare function setLogFormat(format: LogFormat): void;
/**
 * Get the current log format.
 */
export declare function getLogFormat(): LogFormat;
/**
 * Replace the active logger with a custom implementation.
 * Pass undefined/null to restore the default console logger.
 */
export declare function setLogger(logger: Logger | undefined | null): void;
/**
 * Get the active logger instance.
 */
export declare function getLogger(): Logger;
