/**
 * Error fingerprinting — deterministic grouping of similar errors.
 *
 * Generates a SHA-256 fingerprint from:
 * - Error name (type)
 * - In-app stack frames (function + normalized filename)
 * - Error message (with dynamic values stripped)
 *
 * Supports custom fingerprint overrides via event context.
 */
import { sha256 } from '../utils/hash.js';
// ─── Fingerprint Cache ──────────────────────────────────────────────────────
const FINGERPRINT_CACHE_SIZE = 1000;
const FINGERPRINT_CACHE_TTL_MS = 60_000;
const fingerprintCache = new Map();
function getCachedFingerprint(key) {
    const entry = fingerprintCache.get(key);
    if (!entry)
        return undefined;
    if (Date.now() > entry.expiresAt) {
        fingerprintCache.delete(key);
        return undefined;
    }
    // Promote to MRU
    fingerprintCache.delete(key);
    fingerprintCache.set(key, entry);
    return entry.value;
}
function setCachedFingerprint(key, value) {
    if (fingerprintCache.size >= FINGERPRINT_CACHE_SIZE) {
        // Evict the oldest (LRU) entry
        const oldest = fingerprintCache.keys().next().value;
        if (oldest !== undefined) {
            fingerprintCache.delete(oldest);
        }
    }
    fingerprintCache.set(key, { value, expiresAt: Date.now() + FINGERPRINT_CACHE_TTL_MS });
}
// ─── Public API ─────────────────────────────────────────────────────────────
/**
 * Generate a deterministic fingerprint for error grouping.
 * Same error type + same call path = same fingerprint.
 *
 * Cached with a bounded LRU to avoid recomputing SHA-256 for repeated
 * identical errors in high-throughput scenarios.
 *
 * @param error - The normalized error
 * @param stackFrames - Parsed stack frames
 * @param customFingerprint - Optional explicit fingerprint override
 */
export function generateFingerprint(error, stackFrames, customFingerprint) {
    // If user provides a custom fingerprint, hash it once and cache.
    if (customFingerprint) {
        const cached = getCachedFingerprint(customFingerprint);
        if (cached)
            return cached;
        const value = sha256(customFingerprint);
        setCachedFingerprint(customFingerprint, value);
        return value;
    }
    // Build fingerprint from error type + in-app stack frames
    const parts = [error.name];
    // Use in-app frames for grouping — library frames are noisy
    const inAppFrames = stackFrames.filter(f => f.inApp);
    if (inAppFrames.length > 0) {
        for (const frame of inAppFrames) {
            // Normalize filename: strip line numbers, query params, hashes
            const normalizedFile = normalizeForFingerprint(frame.filename);
            parts.push(`${frame.function}@${normalizedFile}`);
        }
    }
    else {
        // Fallback: use all frames if no in-app frames found
        for (const frame of stackFrames.slice(0, 5)) {
            const normalizedFile = normalizeForFingerprint(frame.filename);
            parts.push(`${frame.function}@${normalizedFile}`);
        }
    }
    // Include normalized error message (strip dynamic values)
    parts.push(normalizeErrorMessage(error.message));
    const key = parts.join('|');
    const cached = getCachedFingerprint(key);
    if (cached)
        return cached;
    const value = sha256(key);
    setCachedFingerprint(key, value);
    return value;
}
/**
 * Normalize a filename for fingerprinting:
 * - Strip query parameters and hash fragments
 * - Strip line:col suffixes
 * - Normalize path separators
 */
function normalizeForFingerprint(filename) {
    return filename
        .replace(/[?#].*$/, '') // Strip query params and hash
        .replace(/:\d+:\d+$/, '') // Strip :line:col
        .replace(/\\/g, '/'); // Normalize separators
}
/**
 * Normalize an error message for fingerprinting:
 * - Replace numbers with <N>
 * - Replace UUIDs with <UUID>
 * - Replace quoted strings with <S>
 * - Replace hex hashes with <H>
 */
function normalizeErrorMessage(message) {
    return message
        .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<UUID>')
        .replace(/\b[0-9a-f]{40}\b/gi, '<H>') // SHA1 hashes
        .replace(/\b[0-9a-f]{64}\b/gi, '<H>') // SHA256 hashes
        .replace(/\b\d+\b/g, '<N>') // Numbers
        .replace(/"[^"]*"/g, '<S>') // Double-quoted strings
        .replace(/'[^']*'/g, '<S>'); // Single-quoted strings
}
