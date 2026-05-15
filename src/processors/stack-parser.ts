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

import type { StackFrame } from '../types/event.js'
export type { StackFrame } from '../types/event.js'

// ─── V8 Stack Frame Patterns ────────────────────────────────────────────────

// Matches: "    at FunctionName (file:line:col)"
const V8_FRAME_WITH_PARENS = /^\s*at\s+(.+?)\s+\((.+?):(\d+):(\d+)\)$/
// Matches: "    at file:line:col" (anonymous)
const V8_FRAME_ANONYMOUS = /^\s*at\s+(.+?):(\d+):(\d+)$/
// Matches: "    at eval (eval at ..., file:line:col)"
const V8_EVAL_FRAME = /^\s*at\s+eval\s+\(eval\s+at\s+(.+?)\s+\((.+?):(\d+):(\d+)\)/

// Frames to always exclude from parsed output
const INTERNAL_FRAME_PATTERNS = [
  /^node:/,
  /^internal\//,
  /\bbootstrap_node\b/,
  /\bmodule\.js\b/,
]

/**
 * Parse an Error.stack string into structured stack frames.
 * Filters out internal Node.js frames.
 * Returns frames in call-order (most recent first).
 */
export function parseStack(stack?: string): StackFrame[] {
  if (!stack) return []

  return stack
    .split('\n')
    .slice(1) // Skip the error message line
    .map(line => line.trim())
    .filter(line => line.startsWith('at '))
    .map(parseLine)
    .filter((frame): frame is StackFrame => frame !== null)
    .filter(frame => !isInternalFrame(frame.filename))
}

function parseLine(line: string): StackFrame | null {
  // Try eval frame first
  const evalMatch = V8_EVAL_FRAME.exec(line)
  if (evalMatch) {
    return createFrame(
      evalMatch[1] ?? '<eval>',
      evalMatch[2] ?? '<unknown>',
      parseInt(evalMatch[3] ?? '0', 10),
      parseInt(evalMatch[4] ?? '0', 10)
    )
  }

  // Standard frame with function name
  const standardMatch = V8_FRAME_WITH_PARENS.exec(line)
  if (standardMatch) {
    return createFrame(
      standardMatch[1] ?? '<anonymous>',
      standardMatch[2] ?? '<unknown>',
      parseInt(standardMatch[3] ?? '0', 10),
      parseInt(standardMatch[4] ?? '0', 10)
    )
  }

  // Anonymous frame (no function name)
  const anonMatch = V8_FRAME_ANONYMOUS.exec(line)
  if (anonMatch) {
    return createFrame(
      '<anonymous>',
      anonMatch[1] ?? '<unknown>',
      parseInt(anonMatch[2] ?? '0', 10),
      parseInt(anonMatch[3] ?? '0', 10)
    )
  }

  return null
}

function createFrame(
  fn: string,
  filename: string,
  lineno: number,
  colno: number
): StackFrame {
  return {
    function: fn,
    filename: normalizeFilename(filename),
    lineno: lineno > 0 ? lineno : undefined,
    colno: colno > 0 ? colno : undefined,
    inApp: isInAppFrame(filename),
    module: extractModule(filename),
  }
}

/**
 * Determine if a frame is "in-app" (user code, not library/runtime).
 */
function isInAppFrame(filename: string): boolean {
  if (filename.includes('node_modules')) return false
  if (filename.startsWith('node:')) return false
  if (filename.startsWith('internal/')) return false
  if (filename.includes('<anonymous>')) return false
  return true
}

/**
 * Check if a frame is a Node.js internal frame that should be excluded entirely.
 */
function isInternalFrame(filename: string): boolean {
  return INTERNAL_FRAME_PATTERNS.some(pattern => pattern.test(filename))
}

/**
 * Normalize filenames — strip file:// protocol, normalize separators.
 */
function normalizeFilename(filename: string): string {
  // Strip file:// protocol (ESM imports)
  let normalized = filename.replace(/^file:\/\//, '')

  // Normalize Windows backslashes to forward slashes
  normalized = normalized.replace(/\\/g, '/')

  return normalized
}

/**
 * Extract module name from a filename.
 * e.g., "/app/src/services/payment.ts" → "services/payment"
 */
function extractModule(filename: string): string | undefined {
  const normalized = normalizeFilename(filename)

  // Remove file extension
  const withoutExt = normalized.replace(/\.(ts|js|mjs|cjs|tsx|jsx)$/, '')

  // Try to extract relative to src/
  const srcIndex = withoutExt.indexOf('/src/')
  if (srcIndex !== -1) {
    return withoutExt.slice(srcIndex + 5) // skip '/src/'
  }

  // Fallback: just the filename without extension
  const lastSlash = withoutExt.lastIndexOf('/')
  return lastSlash !== -1 ? withoutExt.slice(lastSlash + 1) : undefined
}