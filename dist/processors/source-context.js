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
import { readFile } from 'node:fs/promises';
import { extname, normalize } from 'node:path';
import { getLogger } from '../utils/logger.js';
// ─── Constants ──────────────────────────────────────────────────────────────
/** Max files cached in LRU. */
const MAX_CACHED_FILES = 50;
/** Max lines to cache per file. */
const MAX_LINES_PER_FILE = 500;
/** Lines of context before and after the error line. */
const CONTEXT_LINES = 5;
/** Timeout for reading a single file (ms). */
const FILE_READ_TIMEOUT_MS = 50;
/** Total timeout for attaching source context to all frames in an error (ms). */
const TOTAL_TIMEOUT_MS = 200;
/** Allowed source file extensions. */
const ALLOWED_EXTENSIONS = new Set(['.ts', '.js', '.mjs', '.cjs']);
/** Patterns to skip. */
const SKIP_PATTERNS = [
    /node_modules/,
    /\.min\.js$/,
    /\.bundle\.js$/,
];
// ─── LRU Cache ──────────────────────────────────────────────────────────────
/** Simple LRU cache for file line arrays. */
class FileCache {
    cache = new Map();
    maxSize;
    constructor(maxSize) {
        this.maxSize = maxSize;
    }
    get(key) {
        const value = this.cache.get(key);
        if (value !== undefined) {
            // Move to end (most recently used)
            this.cache.delete(key);
            this.cache.set(key, value);
        }
        return value;
    }
    set(key, value) {
        if (this.cache.has(key)) {
            this.cache.delete(key);
        }
        else if (this.cache.size >= this.maxSize) {
            // Evict oldest entry
            const oldest = this.cache.keys().next().value;
            if (oldest !== undefined) {
                this.cache.delete(oldest);
            }
        }
        this.cache.set(key, value);
    }
    clear() {
        this.cache.clear();
    }
}
/** Singleton file cache. */
const fileCache = new FileCache(MAX_CACHED_FILES);
/** Set of files that failed to load — avoid retrying. */
const failedFiles = new Set();
// ─── Public API ─────────────────────────────────────────────────────────────
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
export async function attachSourceContext(frames) {
    if (!frames || frames.length === 0)
        return [];
    const logger = getLogger();
    const startTime = Date.now();
    try {
        const result = [];
        for (const frame of frames) {
            // Check total timeout
            if (Date.now() - startTime > TOTAL_TIMEOUT_MS) {
                logger.debug('[SourceContext] Total timeout exceeded, skipping remaining frames');
                result.push(frame);
                continue;
            }
            // Skip frames without enough info
            if (!frame.filename || !frame.lineno || frame.lineno < 1) {
                result.push(frame);
                continue;
            }
            // Skip non-source files
            if (!isAllowedFile(frame.filename)) {
                result.push(frame);
                continue;
            }
            try {
                const lines = await getFileLines(frame.filename);
                if (!lines) {
                    result.push(frame);
                    continue;
                }
                const lineno = frame.lineno; // 1-indexed
                const lineIndex = lineno - 1;
                if (lineIndex < 0 || lineIndex >= lines.length) {
                    result.push(frame);
                    continue;
                }
                const preStart = Math.max(0, lineIndex - CONTEXT_LINES);
                const postEnd = Math.min(lines.length, lineIndex + CONTEXT_LINES + 1);
                const sourceContext = {
                    pre: lines.slice(preStart, lineIndex),
                    line: lines[lineIndex] ?? '',
                    post: lines.slice(lineIndex + 1, postEnd),
                };
                result.push({ ...frame, sourceContext });
            }
            catch {
                // Per-frame errors are silently swallowed
                result.push(frame);
            }
        }
        return result;
    }
    catch (err) {
        logger.debug('[SourceContext] Failed to attach source context', { error: String(err) });
        return [...frames];
    }
}
/**
 * Reset the source context file cache.
 * Useful for testing.
 */
export function resetSourceContextCache() {
    fileCache.clear();
    failedFiles.clear();
}
// ─── Internal ───────────────────────────────────────────────────────────────
/**
 * Check if a file path is eligible for source context reading.
 */
function isAllowedFile(filename) {
    const ext = extname(filename).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext))
        return false;
    const normalized = normalize(filename);
    for (const pattern of SKIP_PATTERNS) {
        if (pattern.test(normalized))
            return false;
    }
    return true;
}
/**
 * Get cached file lines, or read from disk with timeout.
 * Returns null if the file can't be read.
 */
async function getFileLines(filename) {
    // Check negative cache
    if (failedFiles.has(filename))
        return null;
    // Check LRU cache
    const cached = fileCache.get(filename);
    if (cached)
        return cached;
    // Read file with timeout
    try {
        const content = await withTimeout(readFile(filename, 'utf-8'), FILE_READ_TIMEOUT_MS);
        if (content === null) {
            failedFiles.add(filename);
            return null;
        }
        // Split into lines and cap at MAX_LINES_PER_FILE
        let lines = content.split('\n');
        if (lines.length > MAX_LINES_PER_FILE) {
            lines = lines.slice(0, MAX_LINES_PER_FILE);
        }
        const frozenLines = Object.freeze(lines);
        fileCache.set(filename, frozenLines);
        return frozenLines;
    }
    catch {
        failedFiles.add(filename);
        return null;
    }
}
/**
 * Wrap a promise with a timeout. Returns null if the timeout fires first.
 */
async function withTimeout(promise, timeoutMs) {
    let timer;
    try {
        return await Promise.race([
            promise,
            new Promise((resolve) => {
                timer = setTimeout(() => resolve(null), timeoutMs);
                if (typeof timer === 'object' && 'unref' in timer) {
                    ;
                    timer.unref();
                }
            }),
        ]);
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
}
//# sourceMappingURL=source-context.js.map