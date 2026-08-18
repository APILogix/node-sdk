/**
 * Error capture — captures exceptions and routes them through the event pipeline.
 * Features ultra-minimal two-argument signature: captureError(error, severity?).
 */
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
 * @param severity - Optional severity level ('fatal' | 'error' | 'warning' | 'info' | 'debug'). Defaults to 'error'.
 */
export declare function captureError(error: unknown, severity?: ErrorSeverity): void;
//# sourceMappingURL=captureError.d.ts.map