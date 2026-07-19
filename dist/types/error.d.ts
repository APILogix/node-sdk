/**
 * Error-related types for structured error representation.
 */
import type { StackFrame } from './event.js';
import type { SeverityLevel } from './severity.js';
/**
 * Options for captureError — allows specifying severity, fingerprint, and context.
 */
export interface CaptureErrorOptions {
    /** Override the default severity level (defaults to 'error'). */
    severity?: SeverityLevel;
    /** Custom fingerprint for error grouping. If not provided, auto-generated from stack. */
    fingerprint?: string;
    /** Additional context data to attach to the error event. */
    context?: Record<string, unknown>;
    /** Mechanism that caused the error (e.g., 'uncaughtException', 'unhandledRejection'). */
    mechanism?: string;
    /** Tags to attach to the error event. */
    tags?: Record<string, string>;
}
/**
 * Parsed error with structured stack trace, used internally.
 */
export interface ParsedError {
    readonly name: string;
    readonly message: string;
    readonly stack: readonly StackFrame[];
    readonly cause?: ParsedError;
}
/**
 * Error grouping metadata produced by the fingerprinter.
 */
export interface ErrorGrouping {
    /** SHA-256 fingerprint for deterministic grouping. */
    readonly fingerprint: string;
    /** Human-readable grouping title. */
    readonly title: string;
    /** Number of in-app stack frames used for grouping. */
    readonly inAppFrameCount: number;
}
//# sourceMappingURL=error.d.ts.map