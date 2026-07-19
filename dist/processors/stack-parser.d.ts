/**
 * Stack frame parser — extracts structured stack frames from errors.
 *
 * Architecture:
 *   Uses V8's structured CallSite API via Error.prepareStackTrace for
 *   primary parsing. Falls back to regex-based parsing for:
 *     - Pre-captured Error.stack strings (already serialized)
 *     - Non-V8 runtimes (edge cases)
 *     - Third-party errors with custom .stack properties
 *
 * V8 CallSite API advantages over regex:
 *   - Version-resilient: structured API doesn't change format
 *   - Async stack support: CallSites from async stack traces are handled natively
 *   - Worker-thread compatible: works identically in worker_threads
 *   - Accurate: no regex ambiguity for complex filenames/function names
 *   - eval context: getEvalOrigin() provides structured eval info
 *
 * Regex fallback is retained because:
 *   - Error.stack may already be serialized (e.g., from JSON logs, RPC)
 *   - Some errors have custom .stack properties (non-V8 format)
 *   - prepareStackTrace is a global hook — we use it thread-locally
 *     and restore immediately to avoid interfering with third-party code
 *
 * Classifies frames as in-app vs library (node_modules, node: internals).
 * Compatible with OTel exception.stacktrace semantic conventions.
 */
import type { StackFrame } from '../types/event.js';
export type { StackFrame } from '../types/event.js';
/**
 * Parse an Error into structured stack frames.
 *
 * Primary path: V8 CallSite API (structured, version-resilient)
 * Fallback path: regex parsing of Error.stack string
 *
 * Accepts either a live Error object or a pre-serialized stack string.
 * When a live Error is provided, the CallSite API is preferred for accuracy.
 *
 * Returns frames in call-order (most recent first).
 * Filters out internal Node.js frames.
 */
export declare function parseStack(stack?: string, error?: Error): StackFrame[];
//# sourceMappingURL=stack-parser.d.ts.map