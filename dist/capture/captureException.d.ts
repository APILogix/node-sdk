/**
 * Error capture — captures exceptions and routes them through the event pipeline.
 * Features canonical signature: captureException(error, severity?).
 */
import { type SeverityLevel } from '../types/severity.js';
import type { ErrorSeverity } from '../types/error.js';
export type { ErrorSeverity };
/**
 * Capture an error/exception.
 *
 * Error capture is synchronous for minimal latency. Source map resolution
 * is deferred to the event pipeline's async processing stage.
 *
 * Remote config gates:
 *   killswitches.disableErrors → no-op
 *   sampling.errors → probabilistic drop
 *   errors.grouping.normalizePaths → strip absolute paths in fingerprint
 *
 * @param error - The error to capture (Error, string, or unknown)
 * @param severity - Optional severity level ('fatal' | 'error' | 'warning' | 'info' | 'debug') or options object with severity. Defaults to 'error'.
 */
export declare function captureException(error: unknown, severity?: ErrorSeverity | {
    severity?: ErrorSeverity;
} | SeverityLevel): void;
