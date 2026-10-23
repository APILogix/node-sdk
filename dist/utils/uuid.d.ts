/**
 * Generates an RFC 9562 compliant UUIDv7 string.
 *
 * Layout:
 * - 48 bits: Unix timestamp in milliseconds (`Date.now()`).
 * -  4 bits: Version `0b0111` (`7`).
 * - 12 bits: Intra-millisecond sequence counter (`rand_a`) for monotonic ordering.
 * -  2 bits: Variant `0b10` (RFC 9562 / RFC 4122).
 * - 62 bits: Cryptographically secure pseudorandom entropy (`rand_b`).
 *
 * Optimizations:
 * 1. 4096-byte batched entropy pool via `randomFillSync` avoids per-call CSPRNG syscalls.
 * 2. 256-entry lookup table for instant byte-to-hex formatting without allocations.
 * 3. Monotonic sub-millisecond sequence tracking ensures optimal PostgreSQL B-tree locality.
 */
export declare function generateId(): string;
/**
 * Direct alias for generateId() adhering to RFC 9562 UUIDv7.
 */
export declare const generateUuidV7: typeof generateId;
/**
 * Generates a compact 16-character hex ID (64-bit entropy).
 * Useful for span IDs and short correlation identifiers.
 * Reads directly from the pre-allocated entropy pool.
 */
export declare function generateShortId(): string;
/**
 * Validates a standard UUID string format (supporting RFC 9562 v7 and RFC 4122 v1-v5).
 */
export declare function isValidUUID(value: string): boolean;
/**
 * Validates specifically that a UUID is version 7 per RFC 9562.
 */
export declare function isValidUUIDv7(value: string): boolean;
/**
 * Extracts the 48-bit Unix epoch millisecond timestamp embedded in a UUIDv7.
 * Returns `null` if the provided string is not a valid RFC 9562 UUIDv7.
 */
export declare function extractTimestampFromUUIDv7(uuid: string): number | null;
