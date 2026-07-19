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
import type { StackFrame } from './stack-parser.js';
/**
 * Generate a deterministic fingerprint for error grouping.
 * Same error type + same call path = same fingerprint.
 *
 * @param error - The normalized error
 * @param stackFrames - Parsed stack frames
 * @param customFingerprint - Optional explicit fingerprint override
 */
export declare function generateFingerprint(error: Error, stackFrames: StackFrame[], customFingerprint?: string): string;
//# sourceMappingURL=fingerprint.d.ts.map