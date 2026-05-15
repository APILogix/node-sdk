/**
 * Stack frame parser — extracts structured stack frames from Error.stack strings.
 *
 * Supports:
 * - V8 stack format (Node.js, Chrome)
 * - Windows and Unix file paths
 * - ESM file:// URLs
 * - Anonymous functions
 * - eval contexts
 *
 * Classifies frames as in-app vs library (node_modules, node: internals).
 */
import type { StackFrame } from '../types/event.js';
export type { StackFrame } from '../types/event.js';
/**
 * Parse an Error.stack string into structured stack frames.
 * Filters out internal Node.js frames.
 * Returns frames in call-order (most recent first).
 */
export declare function parseStack(stack?: string): StackFrame[];
//# sourceMappingURL=stack-parser.d.ts.map