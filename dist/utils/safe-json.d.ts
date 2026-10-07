/**
 * Safe JSON serialization utilities for telemetry payloads.
 * Prevents BigInt serialization crashes (SEC-04) and handles circular references.
 */
export declare function safeJsonReplacer(_key: string, value: unknown): unknown;
/**
 * Serializes a value to JSON safely.
 * Converts BigInt primitives to strings (JSON does not natively support BigInt).
 * Gracefully handles circular references by replacing them with '[Circular]'.
 */
export declare function safeJsonStringify(value: unknown, space?: string | number): string;
