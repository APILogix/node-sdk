/**
 * SDK Logger — Sentry-style debug logging.
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
 *   Both loggers below now write directly to `process.stdout` (info /
 *   debug) or `process.stderr` (warn / error). The LoggingSubsystem's
 *   wrapper never sees these writes, so the feedback loop is broken at
 *   the source.
 *
 *   PII redaction is always applied regardless of debug mode.
 */
import { type SeverityLevel } from '../types/severity.js';
export interface Logger {
    debug(message: string, context?: Record<string, unknown>): void;
    info(message: string, context?: Record<string, unknown>): void;
    warn(message: string, context?: Record<string, unknown>): void;
    error(message: string, context?: Record<string, unknown>): void;
}
/**
 * Enable or disable debug logging globally.
 * Called during SDK initialization based on `options.debug`.
 */
export declare function setDebugMode(enabled: boolean): void;
/**
 * Set the minimum SDK internal log level.
 */
export declare function setLogLevel(level: SeverityLevel): void;
/**
 * Set the log prefix (defaults to 'Pulse').
 */
export declare function setLogPrefix(prefix: string): void;
export declare function redact(value: unknown, depth?: number): unknown;
export declare const consoleLogger: Logger;
/**
 * Structured JSON logger — emits newline-delimited JSON (NDJSON) suitable
 * for production log aggregation systems (ELK, Datadog, CloudWatch, etc.).
 *
 * Every log entry includes:
 * - ISO timestamp
 * - Log level
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
