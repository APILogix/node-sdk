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
// ─── V8 Structured Parsing ──────────────────────────────────────────────────
/**
 * Extract structured stack frames from a live Error object using V8's
 * CallSite API via a temporary prepareStackTrace hook.
 *
 * This is the primary parsing path. It provides accurate, version-resilient
 * stack frame extraction without regex.
 *
 * Safety:
 *   - Saves/restores Error.prepareStackTrace immediately
 *   - Never leaks the custom hook
 *   - Isolated per-call (no global mutation beyond the hook swap)
 *   - Accessing error.stack triggers V8 to call our hook exactly once
 *   - After restoration, the original .stack string is available
 */
function extractCallSites(error) {
    // V8 environments expose prepareStackTrace on the Error constructor
    if (typeof Error.prepareStackTrace !== 'function' && Error.prepareStackTrace !== undefined) {
        // prepareStackTrace exists but isn't a function — unusual runtime, bail
        return null;
    }
    const originalPrepare = Error.prepareStackTrace;
    let callSites = null;
    try {
        Error.prepareStackTrace = (_err, sites) => {
            callSites = sites;
            // Return a dummy string — we don't need the formatted output
            return '';
        };
        // Access .stack to trigger V8's prepareStackTrace
        // This is the documented V8 API — it's not a hack
        void error.stack;
    }
    finally {
        // ALWAYS restore — even if prepareStackTrace throws
        Error.prepareStackTrace = originalPrepare;
    }
    return callSites;
}
/**
 * Convert a V8 CallSite into our StackFrame structure.
 */
function callSiteToFrame(site) {
    const filename = resolveCallSiteFilename(site);
    const fn = resolveCallSiteFunctionName(site);
    const lineno = site.getLineNumber();
    const colno = site.getColumnNumber();
    return {
        function: fn,
        filename: normalizeFilename(filename),
        lineno: lineno != null && lineno > 0 ? lineno : undefined,
        colno: colno != null && colno > 0 ? colno : undefined,
        inApp: isInAppFrame(filename),
        module: extractModule(filename),
    };
}
/**
 * Resolve the filename from a CallSite, handling eval contexts.
 */
function resolveCallSiteFilename(site) {
    if (site.isEval()) {
        // Eval frames: getEvalOrigin() returns e.g. "eval at foo (file.js:1:1)"
        const evalOrigin = site.getEvalOrigin();
        if (evalOrigin) {
            // Try to extract the actual file from the eval origin
            const match = /\((.+?):\d+:\d+\)/.exec(evalOrigin);
            if (match && match[1])
                return match[1];
            return evalOrigin;
        }
    }
    return site.getFileName() ?? '<unknown>';
}
/**
 * Resolve a human-readable function name from a CallSite.
 * Combines type name + method name for method calls.
 */
function resolveCallSiteFunctionName(site) {
    const fnName = site.getFunctionName();
    if (fnName)
        return fnName;
    const methodName = site.getMethodName();
    const typeName = site.getTypeName();
    if (typeName && methodName) {
        return `${typeName}.${methodName}`;
    }
    if (methodName)
        return methodName;
    if (typeName)
        return typeName;
    return '<anonymous>';
}
// ─── Regex Fallback ─────────────────────────────────────────────────────────
// Matches: "    at FunctionName (file:line:col)"
const V8_FRAME_WITH_PARENS = /^\s*at\s+(.+?)\s+\((.+?):(\d+):(\d+)\)$/;
// Matches: "    at file:line:col" (anonymous)
const V8_FRAME_ANONYMOUS = /^\s*at\s+(.+?):(\d+):(\d+)$/;
// Matches: "    at eval (eval at ..., file:line:col)"
const V8_EVAL_FRAME = /^\s*at\s+eval\s+\(eval\s+at\s+(.+?)\s+\((.+?):(\d+):(\d+)\)/;
// Matches: "    at async FunctionName (file:line:col)"
const V8_ASYNC_FRAME = /^\s*at\s+async\s+(.+?)\s+\((.+?):(\d+):(\d+)\)$/;
/**
 * Parse a stack frame line using regex patterns.
 * Used as fallback when CallSite API is unavailable.
 */
function parseLineRegex(line) {
    // Try eval frame first
    const evalMatch = V8_EVAL_FRAME.exec(line);
    if (evalMatch) {
        return createFrame(evalMatch[1] ?? '<eval>', evalMatch[2] ?? '<unknown>', parseInt(evalMatch[3] ?? '0', 10), parseInt(evalMatch[4] ?? '0', 10));
    }
    // Async frame (Node.js 12+ async stack traces)
    const asyncMatch = V8_ASYNC_FRAME.exec(line);
    if (asyncMatch) {
        return createFrame(`async ${asyncMatch[1] ?? '<anonymous>'}`, asyncMatch[2] ?? '<unknown>', parseInt(asyncMatch[3] ?? '0', 10), parseInt(asyncMatch[4] ?? '0', 10));
    }
    // Standard frame with function name
    const standardMatch = V8_FRAME_WITH_PARENS.exec(line);
    if (standardMatch) {
        return createFrame(standardMatch[1] ?? '<anonymous>', standardMatch[2] ?? '<unknown>', parseInt(standardMatch[3] ?? '0', 10), parseInt(standardMatch[4] ?? '0', 10));
    }
    // Anonymous frame (no function name)
    const anonMatch = V8_FRAME_ANONYMOUS.exec(line);
    if (anonMatch) {
        return createFrame('<anonymous>', anonMatch[1] ?? '<unknown>', parseInt(anonMatch[2] ?? '0', 10), parseInt(anonMatch[3] ?? '0', 10));
    }
    return null;
}
/**
 * Parse an Error.stack string using regex fallback.
 * Bounded to prevent runaway CPU/memory on massive or malformed stacks.
 */
function parseStackString(stack) {
    const MAX_STACK_CHARS = 64_000;
    const MAX_STACK_LINES = 500;
    if (stack.length > MAX_STACK_CHARS) {
        stack = stack.slice(0, MAX_STACK_CHARS);
    }
    const lines = stack.split('\n');
    const bounded = lines.length > MAX_STACK_LINES ? lines.slice(0, MAX_STACK_LINES) : lines;
    return bounded
        .slice(1) // Skip the error message line
        .map(line => line.trim())
        .filter(line => line.startsWith('at '))
        .map(parseLineRegex)
        .filter((frame) => frame !== null)
        .filter(frame => !isInternalFrame(frame.filename));
}
// ─── Public API ─────────────────────────────────────────────────────────────
// Frames to always exclude from parsed output
const INTERNAL_FRAME_PATTERNS = [
    /^node:/,
    /^internal\//,
    /\bbootstrap_node\b/,
    /\bmodule\.js\b/,
];
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
export function parseStack(stack, error) {
    // Path 1: Live Error object — try V8 structured CallSite API first
    if (error) {
        const callSites = extractCallSites(error);
        if (callSites && callSites.length > 0) {
            return callSites
                .filter(site => !site.isNative())
                .map(callSiteToFrame)
                .filter(frame => !isInternalFrame(frame.filename));
        }
    }
    // Path 2: Pre-serialized stack string — regex fallback
    if (!stack)
        return [];
    return parseStackString(stack);
}
// ─── Shared Helpers ─────────────────────────────────────────────────────────
function createFrame(fn, filename, lineno, colno) {
    return {
        function: fn,
        filename: normalizeFilename(filename),
        lineno: lineno > 0 ? lineno : undefined,
        colno: colno > 0 ? colno : undefined,
        inApp: isInAppFrame(filename),
        module: extractModule(filename),
    };
}
/**
 * Determine if a frame is "in-app" (user code, not library/runtime).
 */
function isInAppFrame(filename) {
    if (filename.includes('node_modules'))
        return false;
    if (filename.startsWith('node:'))
        return false;
    if (filename.startsWith('internal/'))
        return false;
    if (filename.includes('<anonymous>'))
        return false;
    if (filename.includes('<unknown>'))
        return false;
    return true;
}
/**
 * Check if a frame is a Node.js internal frame that should be excluded entirely.
 */
function isInternalFrame(filename) {
    return INTERNAL_FRAME_PATTERNS.some(pattern => pattern.test(filename));
}
/**
 * Normalize filenames — strip file:// protocol, normalize separators.
 */
function normalizeFilename(filename) {
    // Strip file:// protocol (ESM imports)
    let normalized = filename.replace(/^file:\/\//, '');
    // Normalize Windows backslashes to forward slashes
    normalized = normalized.replace(/\\/g, '/');
    return normalized;
}
/**
 * Extract module name from a filename.
 * e.g., "/app/src/services/payment.ts" → "services/payment"
 */
function extractModule(filename) {
    const normalized = normalizeFilename(filename);
    // Remove file extension
    const withoutExt = normalized.replace(/\.(ts|js|mjs|cjs|tsx|jsx)$/, '');
    // Try to extract relative to src/
    const srcIndex = withoutExt.indexOf('/src/');
    if (srcIndex !== -1) {
        return withoutExt.slice(srcIndex + 5); // skip '/src/'
    }
    // Fallback: just the filename without extension
    const lastSlash = withoutExt.lastIndexOf('/');
    return lastSlash !== -1 ? withoutExt.slice(lastSlash + 1) : undefined;
}
