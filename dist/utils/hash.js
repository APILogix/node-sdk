import { createHash, createHmac } from 'crypto';
/**
 * Compute SHA-256 hex digest of an input string.
 */
export function sha256(input) {
    return createHash('sha256').update(input).digest('hex');
}
/**
 * Compute SHA-1 hex digest of an input string.
 * @deprecated Prefer sha256 for new code. SHA-1 retained for backward compatibility.
 */
export function sha1(input) {
    return createHash('sha1').update(input).digest('hex');
}
/**
 * Compute HMAC-SHA256 hex digest.
 * Used for payload signing in transport layer.
 */
export function hmacSha256(key, data) {
    return createHmac('sha256', key).update(data).digest('hex');
}
