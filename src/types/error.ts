/**
 * Error-related types for structured error representation.
 */

import type { StackFrame } from './event.js'

/**
 * Public error severity levels.
 */
export type ErrorSeverity = 'fatal' | 'error' | 'warning' | 'info' | 'debug'

/**
 * Strict error mechanism taxonomy for error capture pathways.
 */
export type ErrorMechanism =
  | 'manual'
  | 'express.next'
  | 'express.res.error'
  | 'fastify.onError'
  | 'uncaughtException'
  | 'unhandledRejection'
  | 'console.error'
  | 'framework'
  | 'unknown'

/**
 * Derived boolean error classification flags.
 */
export interface ErrorClassification {
  readonly unhandled: boolean
  readonly fatal: boolean
  readonly crash: boolean
}

export { classifyError } from '../core/error-classifier.js'

/**
 * Parsed error with structured stack trace, used internally.
 */
export interface ParsedError {
  readonly name: string
  readonly message: string
  readonly stack: readonly StackFrame[]
  readonly cause?: ParsedError
}

/**
 * Error grouping metadata produced by the fingerprinter.
 */
export interface ErrorGrouping {
  /** SHA-256 fingerprint for deterministic grouping. */
  readonly fingerprint: string
  /** Human-readable grouping title. */
  readonly title: string
  /** Number of in-app stack frames used for grouping. */
  readonly inAppFrameCount: number
}

