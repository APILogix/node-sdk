/**
 * Safe JSON serialization utilities for telemetry payloads.
 * Prevents BigInt serialization crashes (SEC-04) and handles circular references.
 */
export function safeJsonReplacer(_key, value) {
    if (typeof value === 'bigint') {
        return value.toString();
    }
    return value;
}
/**
 * Serializes a value to JSON safely.
 * Converts BigInt primitives to strings (JSON does not natively support BigInt).
 * Gracefully handles circular references by replacing them with '[Circular]'.
 */
export function safeJsonStringify(value, space) {
    try {
        return JSON.stringify(value, safeJsonReplacer, space);
    }
    catch (_err) {
        const seen = new WeakSet();
        return JSON.stringify(value, (key, val) => {
            if (typeof val === 'bigint') {
                return val.toString();
            }
            if (typeof val === 'object' && val !== null) {
                if (seen.has(val)) {
                    return '[Circular]';
                }
                seen.add(val);
            }
            return val;
        }, space);
    }
}
