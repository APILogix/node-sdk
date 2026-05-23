/**
 * Error capture — captures exceptions and routes them through the event pipeline.
 * Now integrates with remote-config-driven KillswitchEngine and SamplingEngine.
 *
 * Features:
 * - Pre-init buffering (events captured before SDK is ready are queued)
 * - Killswitch gate: if disableErrors is active, no-op immediately
 * - Sampling gate: uses SamplingEngine.shouldSampleError() for rate control
 * - Automatic breadcrumb attachment from async context
 * - Stack frame parsing and fingerprinting
 * - Severity classification
 * - Plugin processing via event pipeline
 * - Source context attachment when errors.attachSourceContext is true
 *
 * Source map resolution is deferred to the event pipeline to avoid
 * blocking the capture hot path with file I/O.
 */
import { type SeverityLevel } from '../types/severity.js';
export interface CaptureErrorOptions {
    /** Additional context data to attach to the error event. */
    context?: Record<string, unknown>;
    /** Severity level override. Default: 'error'. */
    severity?: SeverityLevel;
    /** Custom fingerprint string for grouping. */
    fingerprint?: string;
}
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
 * @param options - Optional severity, context, and fingerprint overrides
 */
export declare function captureError(error: unknown, options?: CaptureErrorOptions | Record<string, unknown>): void;
//# sourceMappingURL=captureError.d.ts.map