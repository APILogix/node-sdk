/**
 * Generates a cryptographically random UUID v4.
 * Uses Node.js crypto.randomUUID() for secure entropy.
 */
export declare function generateId(): string;
/**
 * Generates a compact 16-character hex ID.
 * Useful for span IDs and short correlation identifiers.
 * Uses the first 16 hex chars of a UUID (64-bit entropy).
 */
export declare function generateShortId(): string;
/**
 * Validates a UUID v4 string format.
 */
export declare function isValidUUID(value: string): boolean;
