/**
 * Error capture — captures exceptions and routes them through the event pipeline.
 *
 * Features:
 * - Pre-init buffering (events captured before SDK is ready are queued)
 * - Automatic breadcrumb attachment from async context
 * - Stack frame parsing and fingerprinting
 * - Severity classification
 * - Plugin processing via event pipeline
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
 * @param error - The error to capture (Error, string, or unknown)
 * @param options - Optional severity, context, and fingerprint overrides
 */
export declare function captureError(error: unknown, options?: CaptureErrorOptions | Record<string, unknown>): void;
//# sourceMappingURL=captureError.d.ts.map