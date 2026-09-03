/**
 * Source Context — bounded source file reader for error stack frames.
 *
 * Attaches surrounding source code lines to each stack frame when
 * `errors.attachSourceContext` is enabled in remote config.
 *
 * Bounded behavior:
 * - LRU cache: max 50 files, each max 500 lines
 * - Context window: 5 lines before + 5 lines after the error line
 * - Only reads: .ts, .js, .mjs, .cjs files
 * - Skips: node_modules/, .min.js files
 * - Per-file I/O timeout: 50ms
 * - Total context attachment timeout: 200ms per error event
 * - Never throws — all errors are swallowed and logged at debug level
 */
import type { StackFrame } from '../types/event.js';
/**
 * Attach source context to stack frames.
 *
 * Returns a new array of StackFrame objects where each frame with a valid
 * filename and line number is enriched with `sourceContext` containing
 * the surrounding source lines.
 *
 * This function never throws. On any error, it returns the original frames
 * unchanged.
 *
 * @param frames - Stack frames from an error event
 * @returns Enriched stack frames with source context
 */
export declare function attachSourceContext(frames: readonly StackFrame[]): Promise<StackFrame[]>;
/**
 * Reset the source context file cache.
 * Useful for testing.
 */
export declare function resetSourceContextCache(): void;
