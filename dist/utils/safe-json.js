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
        return space !== undefined ? JSON.stringify(value, undefined, space) : JSON.stringify(value);
    }
    catch {
        const ancestors = [];
        return JSON.stringify(value, function (_key, val) {
            if (typeof val === 'bigint') {
                return val.toString();
            }
            if (typeof val !== 'object' || val === null) {
                return val;
            }
            while (ancestors.length > 0 && ancestors[ancestors.length - 1] !== this) {
                ancestors.pop();
            }
            if (ancestors.includes(val)) {
                return '[Circular]';
            }
            ancestors.push(val);
            return val;
        }, space);
    }
}
