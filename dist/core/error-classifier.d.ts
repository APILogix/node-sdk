/**
 * Centralized Error Classifier for Pulsiv SDK.
 *
 * Implements deterministic O(1) error classification from raw source facts:
 * - handled (boolean)
 * - mechanism (ErrorMechanism)
 * - severity (ErrorSeverity / SeverityLevel)
 *
 * Produces canonical boolean flags:
 * - unhandled: true when handled is explicitly false (e.g. uncaughtException, unhandledRejection)
 * - fatal: true when severity is 'fatal' (or critical/panic aliases)
 * - crash: true when mechanism is 'uncaughtException'
 */
import type { ErrorClassification, ErrorMechanism, ErrorSeverity } from '../types/error.js';
import type { SeverityLevel } from '../types/severity.js';
/**
 * Deterministically classify an error based solely on authoritative source facts.
 *
 * @param handled - Whether the error was handled by the application (true) or caught by a top-level unhandled handler (false)
 * @param mechanism - How the error was captured (e.g., 'manual', 'express.next', 'uncaughtException', 'unhandledRejection')
 * @param severity - Severity level of the error event ('fatal' | 'error' | 'warning' | 'info' | 'debug')
 * @returns ErrorClassification with unhandled, fatal, and crash booleans
 */
export declare function classifyError(handled: boolean, mechanism: ErrorMechanism | string | undefined, severity: ErrorSeverity | SeverityLevel | string | undefined): ErrorClassification;
