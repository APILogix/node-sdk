/**
 * Compute SHA-256 hex digest of an input string.
 */
export declare function sha256(input: string): string;
/**
 * Compute SHA-1 hex digest of an input string.
 * @deprecated Prefer sha256 for new code. SHA-1 retained for backward compatibility.
 */
export declare function sha1(input: string): string;
/**
 * Compute HMAC-SHA256 hex digest.
 * Used for payload signing in transport layer.
 */
export declare function hmacSha256(key: string, data: string): string;
